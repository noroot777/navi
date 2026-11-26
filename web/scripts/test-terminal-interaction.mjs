import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "../../server/src/terminal.ts";
import { terminalInputChunks } from "../src/workspace/terminalInput.ts";
import { launchChrome } from "./dom-stage.mjs";
import { fetchesSettled, outlastPageTimers, trackFetches } from "./wait-until.mjs";
import { build, preview } from "vite";
import { webkit } from "playwright-core";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { responseCompression } from "../../server/src/response-compression.ts";
import { terminalEventStream } from "../../server/src/terminal-event-stream.ts";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const browserEngine = process.env.NAVI_TERMINAL_BROWSER ?? "chromium";
const native = browserEngine === "native";

const unicode = "a".repeat(16_383) + "😀汉字".repeat(20_000);
const chunks = [...terminalInputChunks(unicode)];
assert.equal(chunks.join(""), unicode);
assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 64 * 1024 && chunk.isWellFormed()));

const scratch = mkdtempSync(join(tmpdir(), "navi-terminal-interaction-"));
const zsh = existsSync("/bin/zsh");
if (zsh) {
  process.env.ZDOTDIR = scratch;
  process.env.EDITOR = "vi";
  process.env.VISUAL = "vi";
  writeFileSync(join(scratch, ".zshenv"), "export NAVI_TEST_ZSHENV=loaded\n");
  writeFileSync(join(scratch, ".zshrc"), [
    "unset HISTFILE",
    "bindkey -M viins '^H' backward-kill-word",
    "printf '\\033[3;4H\\033[6n'",
    "if IFS= read -rst 3 -d R reply && [[ $reply == $'\\e[3;4' ]]; then",
    "  printf '\\r\\n_STARTUP_ANSWER__\\n'",
    "fi",
  ].join("\n") + "\n");
}
const manager = new TerminalSessionManager();
const projectId = "terminal-interaction";
const inputs = [];
const streams = [];
const streamResponses = new Map();
const sizes = new Map();
const outputOf = (sessionId) => manager.eventsAfter(sessionId, projectId, 0)
  ?.filter((event) => event.type === "data").map((event) => event.data).join("") ?? "";
const eventApp = new Hono();
eventApp.use("*", responseCompression());
eventApp.get("*", (context) => {
  context.header("access-control-allow-origin", "*");
  const sessionId = context.req.path.split("/").at(-2);
  const lastEventId = context.req.header("last-event-id");
  streams.push({ sessionId, view: context.req.query("view"), lastEventId });
  return terminalEventStream(context, manager, projectId, sessionId);
});
const eventRequest = getRequestListener(eventApp.fetch);
async function handleBackendRequest(request, response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type,last-event-id,x-navi-human-action-token");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  const json = (body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;
  const base = `/api/projects/${projectId}/terminal/sessions`;
  if (path === base && request.method === "GET") return json({ sessions: manager.listForProject(projectId) });
  if (path.startsWith(base)) {
    const [, sessionId, action] = path.slice(base.length).split("/");
    if (action === "events") {
      if (zsh && !outputOf(sessionId).includes("_STARTUP_ANSWER__") && !streams.some((entry) => entry.sessionId === sessionId)) {
        const until = Date.now() + 3500;
        while (!outputOf(sessionId).includes("_STARTUP_ANSWER__") && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      streamResponses.set(sessionId, response);
      return eventRequest(request, response);
    }
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const raw = Buffer.concat(parts).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    if (path === base && request.method === "POST") {
      const options = zsh ? { shell: "/bin/zsh" } : {};
      return json(await manager.createAsync(projectId, scratch, { ...body, ...options }));
    }
    if (action === "input") {
      if (body.data) inputs.push({ sessionId, data: body.data });
      if (Buffer.byteLength(body.data) > 64 * 1024) return json({ error: "data too large" }, 413);
      manager.write(sessionId, projectId, body.data, body.focused);
      return json({});
    }
    if (action === "resize") {
      sizes.set(sessionId, body);
      manager.resize(sessionId, projectId, body.cols, body.rows, body.theme);
      return json({});
    }
    if (request.method === "DELETE") { await manager.destroy(sessionId, projectId); return json({}); }
  }
  return json({ error: "not found" }, 404);
}
const backend = createServer(handleBackendRequest);
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${backend.address().port}`;
process.env.NAVI_PROXY = origin;
let web;
let browser;
let nativeProbe;
try {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const outDir = join(scratch, "web");
  await build({ root, logLevel: "error", build: { outDir, rollupOptions: {
    input: join(root, "scripts/fixtures/terminal-interaction.html"),
  } } });
  const server = await preview({
    root,
    logLevel: "error",
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [{
      name: "terminal-interaction-backend",
      configurePreviewServer({ middlewares }) {
        middlewares.use((request, response, next) => {
          if (!request.url?.startsWith("/api/")) return next();
          void handleBackendRequest(request, response).catch(next);
        });
      },
    }],
  });
  const address = server.httpServer.address();
  web = { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => {
    server.httpServer.closeAllConnections();
    server.httpServer.close((error) => error ? reject(error) : resolve());
  }) };
  if (native) {
    const executable = join(scratch, "native-terminal-probe");
    const source = (path) => fileURLToPath(new URL(path, import.meta.url));
    execFileSync("swiftc", ["-parse-as-library", source("../../desktop/macos/Sources/NaviWebView.swift"),
      source("../../desktop/macos/Tests/TerminalWebViewProbe.swift"), "-o", executable], { timeout: 60_000 });
    const file = join(scratch, "native-vi.txt");
    const probe = spawn(executable, [`${web.origin}/scripts/fixtures/terminal-interaction.html`, "/tmp/navi-native-terminal.png"], { stdio: ["ignore", "pipe", "inherit"] });
    nativeProbe = probe;
    let pending = "";
    probe.stdout.on("data", (data) => {
      pending += data;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        console.log(line);
        const session = manager.listForProject(projectId)[0];
        if (line === "NATIVE_SHELL_READY") manager.write(session.id, projectId, `vi -N -i NONE -n '${file}'\r`);
        if (line === "NATIVE_SHELL_RESTORED") manager.write(session.id, projectId, "printf '\\137\\137NATIVE_DONE__\\n'\r");
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        probe.kill("SIGKILL");
        reject(new Error("native terminal probe timed out"));
      }, 120_000);
      probe.on("error", (error) => { clearTimeout(timer); reject(error); });
      probe.on("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`native probe exited ${code}`));
      });
    });
    assert.equal(readFileSync(file, "utf8"), "top-native-vi-line\nsecond-line\n");
  } else {
    await runBrowser();
  }
} finally {
  nativeProbe?.kill();
  await browser?.close();
  manager.shutdown();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await web?.close();
  rmSync(scratch, { recursive: true, force: true });
}

async function runBrowser() {
  browser = browserEngine === "webkit" ? await webkit.launch() : await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await trackFetches(page, "/terminal/sessions");
  const settleTerminalRequests = async () => {
    await outlastPageTimers(page, 80);
    await fetchesSettled(page);
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__terminalOpens = [];
    window.__terminalFrames = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        this.addEventListener("open", () => window.__terminalOpens.push(String(url)));
        this.addEventListener("message", (message) => {
          const { seq, full, drop, base, length, lines } = JSON.parse(message.data);
          window.__terminalFrames.push({ url: String(url), seq, full, drop, base, length, updates: lines.length });
          if (window.__terminalFrames.length > 12) window.__terminalFrames.shift();
        });
      }
    };
  });
  await page.goto(`${web.origin}/scripts/fixtures/terminal-interaction.html`);
  await page.getByRole("button", { name: "终端", exact: true }).click();
  const viewport = page.locator(".project-terminal__viewport:not([hidden])");
  const input = viewport.locator("textarea");
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    console.error("INPUT", JSON.stringify(inputs.slice(-20).map(({ sessionId, data }) => ({ sessionId, data: data.slice(0, 250) }))));
    console.error("OUTPUT", JSON.stringify(manager.listForProject(projectId).map((session) => outputOf(session.id).slice(-2500))));
    console.error("STREAMS", streams.slice(-10));
    console.error("FRAMES", await page.evaluate(() => window.__terminalFrames));
    console.error("SCREEN", (await viewport.innerText()).slice(-2500));
    console.error("ERRORS", errors);
    await page.screenshot({ path: "/tmp/navi-terminal-failure.png" });
    throw new Error(`Timed out: ${description}`);
  };
  await waitFor(() => manager.listForProject(projectId).length === 1, "shell created");
  const first = manager.listForProject(projectId)[0].id;
  await waitFor(() => zsh ? outputOf(first).includes("_STARTUP_ANSWER__") && outputOf(first).includes("\x1b[?2004h") : outputOf(first).length > 0, "shell prompt and startup query reply");
  if (zsh) await waitFor(() => viewport.innerText().then((text) => text.includes("_STARTUP_ANSWER__")), "startup output rendered");
  await input.focus();
  await page.keyboard.type("discard-me");
  await page.keyboard.press("Control+k");
  await waitFor(() => inputs.some((entry) => entry.data.includes("\x0b")), "Ctrl+K reaches PTY");
  assert.equal(await page.getByTestId("palette").textContent(), "false");
  await page.keyboard.press("Control+c");

  if (existsSync("/usr/bin/vi") && zsh) {
    await page.keyboard.type("bindkey -e; printf '__ZLE_READY__\\n'");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\n__ZLE_READY__\r\n"), "emacs shell keymap ready");
    const file = join(scratch, "vi-edit.txt");
    await page.keyboard.type(`vi -N -i NONE '${file}'`);
    await page.keyboard.press("Enter");
    await waitFor(() => viewport.innerText().then((text) => /\[New(?: File)?\]/.test(text)), "vi alternate screen");
    await page.keyboard.type("iheader");
    await page.keyboard.press("Enter");
    await page.keyboard.type("tail");
    await page.keyboard.press("Escape");
    await waitFor(() => viewport.innerText().then((text) => text.includes("tail")), "vi inserted text");
    const attachedStreams = () => streams.filter((entry) => entry.sessionId === first && entry.view === "screen").length;
    const beforeReopen = attachedStreams();
    await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
    assert.equal(await page.locator(".project-terminal").isVisible(), false);
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await waitFor(() => attachedStreams() > beforeReopen && viewport.innerText().then((text) => text.includes("tail")), "drawer preserves alternate screen");
    await page.getByRole("button", { name: "新建 CLI" }).click();
    await waitFor(() => manager.listForProject(projectId).length === 2, "second shell created");
    const beforeTabReturn = attachedStreams();
    await page.getByRole("button", { name: /^交互验证（/ }).click();
    await waitFor(() => attachedStreams() > beforeTabReturn, "tab returns to the authoritative screen");
    await input.focus();
    await page.keyboard.type("gg0iTOP-");
    await page.keyboard.press("Escape");
    await page.keyboard.type(":wq");
    await page.keyboard.press("Enter");
    await waitFor(() => existsSync(file), "vi wrote file");
    assert.equal(readFileSync(file, "utf8"), "TOP-header\ntail\n");
    await waitFor(() => outputOf(first).lastIndexOf("\x1b[?2004h") > outputOf(first).lastIndexOf("\x1b[?1049l"), "shell restored after vi");
    await page.keyboard.type("printf '\\137\\137VI_EXIT_READY__\\n'");
    await page.keyboard.press("Enter");
    await waitFor(() => viewport.innerText().then((text) => text.includes("__VI_EXIT_READY__")), "shell return rendered after vi");

    const firstTab = () => page.getByRole("button", { name: /^交互验证（/ });
    const beforeReload = inputs.length;
    await settleTerminalRequests();
    await page.reload();
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await firstTab().click();
    await waitFor(() => viewport.innerText().then((text) => text.includes("__VI_EXIT_READY__")), "history restored after reload");
    await waitFor(() => input.isEditable(), "input enabled after replay");
    await input.focus();
    await page.keyboard.type("printf '\\137RELOADED__\\n'");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\n_RELOADED__\r\n"), "shell accepts a clean command after reload");
    assert.doesNotMatch(inputs.slice(beforeReload).map((entry) => entry.data).join(""), /\x1b(?:\]|\[\?12;)/, "history must not reply to Vim queries");

    const beforeLiveQuery = inputs.length;
    await page.keyboard.type("printf '\\033[?12$p'; IFS= read -rst 3 -d y reply; printf '\\137LIVE_%s__\\n' \"$?\"");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\x1b[?12$p_LIVE_0__\r\n"), "live terminal query received an answer");
    assert.doesNotMatch(inputs.slice(beforeLiveQuery).map((entry) => entry.data).join(""), /\x1b\[\?12;\d+\$y/, "live queries are answered by the session, not the browser");

    const secondTab = () => page.getByRole("button", { name: /^交互验证 2（/ });
    for (const mode of ["HIDDEN", "OTHER_TAB", "RECONNECT"]) {
      const streamCount = streams.filter((entry) => entry.sessionId === first).length;
      const beforeQuery = inputs.length;
      const command = `printf '\\137ARMED_${mode}__\\n'; read -r trigger; printf '\\033[4;7H\\033[6'; sleep 0.05; printf n; if IFS= read -rst 2 -d R reply && [[ $reply == $'\\e[4;7' ]]; then printf '\\r\\n\\137ANSWER_${mode}__\\n'; fi`;
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
      await waitFor(() => outputOf(first).includes(`\r\n_ARMED_${mode}__\r\n`), "query command waiting for trigger");
      if (mode === "HIDDEN") {
        await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
      } else if (mode === "OTHER_TAB") {
        await secondTab().click();
      } else {
        await settleTerminalRequests();
        streamResponses.get(first).destroy();
      }
      manager.write(first, projectId, "\r");
      await waitFor(() => outputOf(first).includes(`\r\n_ANSWER_${mode}__\r\n`), `correct cursor report before reattach (${mode})`);
      assert.equal(streams.filter((entry) => entry.sessionId === first).length, streamCount, "query resolved before reconnect");
      if (mode === "HIDDEN") await page.getByRole("button", { name: "终端", exact: true }).click();
      if (mode === "OTHER_TAB") await firstTab().click();
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_ANSWER_${mode}__`)), "query outcome replays");
      assert.doesNotMatch(inputs.slice(beforeQuery).map((entry) => entry.data).join(""), /\x1b\[\d+;\d+R/);
      await input.focus();
    }

    const displayed = (panel) => panel.evaluate((element) => {
      const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
      for (let fiber = element[key]; fiber; fiber = fiber.return) {
        for (let state = fiber.memoizedState; state?.next; state = state.next) {
          const terminal = state.memoizedState?.current;
          if (!terminal?.buffer?.active || !terminal?.textarea) continue;
          const buffer = terminal.buffer.active;
          return {
            cols: terminal.cols, rows: terminal.rows, base: buffer.baseY, view: buffer.viewportY,
            row: buffer.cursorY + 1, col: buffer.cursorX + 1,
            lines: Array.from({ length: terminal.rows }, (_, index) => buffer.getLine(buffer.baseY + index).translateToString(true)),
            background: terminal.options.theme.background,
          };
        }
      }
      throw new Error("terminal instance not found");
    });
    const waitingCommand = [
      "for i in {1..80}; do print -r ROW-$i; done",
      "printf '\\137GEOMETRY_READY__\\r\\n'",
      "for phase in TALL SHARED; do read -sk 1 trigger; printf '\\033[6n'; IFS= read -rst 2 -d R reply; printf '\\r\\n\\137CURSOR_%s_%s__\\n' \"$phase\" \"${reply##*\\[}\"; done",
    ].join("; ");
    await page.keyboard.type(waitingCommand);
    await page.keyboard.press("Enter");
    await waitFor(() => viewport.innerText().then((text) => text.includes("_GEOMETRY_READY__")), "scrollback present before drag");
    const small = await displayed(viewport);
    assert.ok(small.base > 0);
    const separator = page.getByRole("separator", { name: /调整 CLI 高度/ });
    await separator.dispatchEvent("pointerdown", { button: 0, clientY: 400 });
    await separator.dispatchEvent("pointermove", { clientY: 180 });
    await separator.dispatchEvent("pointerup", { clientY: 180 });
    await waitFor(async () => (await displayed(viewport)).rows > small.rows, "drag applies server geometry");
    const tall = await displayed(viewport);
    assert.ok(tall.row > small.row, "growing the terminal pulls history into the viewport");
    await page.keyboard.type("x");
    const tallReport = `_CURSOR_TALL_${tall.row};${tall.col}__`;
    await waitFor(() => viewport.innerText().then((text) => text.includes(tallReport)), "PTY cursor report matches the taller display");
    const beforeGeometryReconnect = attachedStreams();
    await settleTerminalRequests();
    streamResponses.get(first).destroy();
    await waitFor(() => attachedStreams() > beforeGeometryReconnect, "tall terminal reconnects");
    const otherPage = await browser.newPage({ viewport: { width: 750, height: 850 } });
    try {
      await otherPage.goto(`${web.origin}/scripts/fixtures/terminal-interaction.html`);
      await otherPage.getByRole("button", { name: "终端", exact: true }).click();
      await otherPage.getByRole("button", { name: /^交互验证（/ }).click();
      const otherTerminal = otherPage.locator(".project-terminal__viewport:not([hidden])");
      await waitFor(() => otherTerminal.innerText().then((text) => text.includes(tallReport)), "second window caught up");
      await waitFor(async () => (await displayed(otherTerminal)).cols < tall.cols, "narrow window proposes a new grid");
      await waitFor(async () => {
        const primary = await displayed(viewport);
        return primary.cols < tall.cols && JSON.stringify(primary) === JSON.stringify(await displayed(otherTerminal));
      }, "both windows render the same reflow, cursor and colors");
      const shared = await displayed(viewport);
      await page.screenshot({ path: "/tmp/navi-terminal-geometry.png" });
      manager.write(first, projectId, "x");
      await waitFor(() => outputOf(first).includes(`_CURSOR_SHARED_${shared.row};${shared.col}__\r\n`), "PTY cursor report matches both displays after reflow and reconnect");
      const beforeDual = inputs.length;
      manager.write(first, projectId, "printf '\\033[6n'; IFS= read -rst 2 -d R reply; firstReply=$?; IFS= read -rst 1 -d R repeated; printf '\\r\\n\\137DUAL_%s_%s__\\n' \"$firstReply\" \"$?\"\r");
      await waitFor(() => outputOf(first).includes("_DUAL_0_1__\r\n"), "two windows see only one terminal reply");
      assert.doesNotMatch(inputs.slice(beforeDual).map((entry) => entry.data).join(""), /\x1b\[\d+;\d+R/);
    } finally {
      await otherPage.close();
    }
    await input.focus();
    console.log("PASS: terminal protocol answers before attach, offline, after tab switch, and once across windows");

    const paste = async (text) => input.evaluate((element, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    }, text);
    await paste("print -r -- 'alpha\nbeta'");
    await waitFor(() => inputs.at(-1)?.data.includes("\x1b[201~"), "multiline bracketed paste delivered");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Control+a");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("t");
    await page.keyboard.press("Control+e");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("X");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\nalphX\r\nbeta\r\n"), "first line of multiline paste edited");

    await page.keyboard.type("bindkey -v; bindkey -M viins '^H'; printf '\\137VIINS_%s__\\n' \"$NAVI_TEST_ZSHENV\"");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("\r\n_VIINS_loaded__\r\n"), "login shell profile and vi keymap");
    assert.match(outputOf(first), /"\^H" backward-kill-word/);
    const beforeDelete = inputs.length;
    const deletedPaste = "echo PASTED-FIRST\necho PASTED-SECOND";
    await paste(deletedPaste);
    await waitFor(() => inputs.slice(beforeDelete).some((entry) => entry.data.includes("\x1b[201~")), "vi-mode multiline paste delivered");
    for (let count = 0; count < deletedPaste.length; count += 1) await page.keyboard.press("Backspace");
    await page.keyboard.type("printf '\\137AFTER_DELETE__\\n'");
    await page.keyboard.press("Enter");
    await waitFor(() => outputOf(first).includes("_AFTER_DELETE__\r\n"), "vi-mode backspace crosses pasted newline");
    assert.doesNotMatch(outputOf(first), /\r\nPASTED-(?:FIRST|SECOND)\r\n/);

    const start = inputs.length;
    await paste("#" + unicode);
    await waitFor(() => inputs.slice(start).map((entry) => entry.data).join("").endsWith("\x1b[201~"), "large Unicode paste delivered in order");
    const sent = inputs.slice(start).map((entry) => entry.data).join("");
    const expected = "\x1b[200~#" + unicode + "\x1b[201~";
    const mismatch = Array.from({ length: Math.max(sent.length, expected.length) }, (_, index) => index).find((index) => sent[index] !== expected[index]);
    assert.ok(sent === expected, JSON.stringify({ actualLength: sent.length, expectedLength: expected.length, mismatch,
      actual: sent.slice(mismatch, mismatch + 60), expected: expected.slice(mismatch, mismatch + 60) }));
    assert.ok(inputs.slice(start).every((entry) => Buffer.byteLength(entry.data) <= 64 * 1024));
    await page.keyboard.press("Control+c");
    console.log("PASS: vi editing, silent history replay, live replies, multiline backspace and large Unicode paste");

    for (const automatic of [false, true]) {
      const mode = automatic ? "RECONNECT" : "REOPEN";
      const streamCount = streams.length;
      const flood = "awk 'BEGIN { for (i=0;i<8000;i++) print \"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdefghijklmnopqrstuvwxyz\" }'";
      await input.focus();
      await page.keyboard.type(`printf '\\033[?1049h\\033[H\\137ALT_${mode}__'; read -r line; printf '\\033[?1049l'; ${flood}; printf '\\137TAIL_${mode}__\\n'`);
      await page.keyboard.press("Enter");
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_ALT_${mode}__`)), "alternate screen before history gap");
      const lastBeforeGap = manager.eventsAfter(first, projectId, 0).at(-1).seq;
      if (automatic) {
        await settleTerminalRequests();
        streamResponses.get(first).destroy();
      } else {
        await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
      }
      manager.write(first, projectId, "\r");
      await waitFor(() => outputOf(first).includes(`\r\n_TAIL_${mode}__\r\n`), "output exceeded replay buffer");
      assert.ok(manager.eventsAfter(first, projectId, 0)[0].seq > lastBeforeGap + 1);
      if (!automatic) await page.getByRole("button", { name: "终端", exact: true }).click();
      await waitFor(() => streams.slice(streamCount).some((entry) => entry.sessionId === first && entry.view === "screen" && (!automatic || entry.lastEventId)), "screen stream resumed");
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_TAIL_${mode}__`)), "retained tail rendered");
      await waitFor(() => input.isEditable(), "input enabled after truncated replay");
      await input.focus();
      await page.keyboard.type(`printf '\\033[?1047l\\137MAIN_${mode}__\\n'`);
      await page.keyboard.press("Enter");
      await waitFor(async () => {
        const state = await displayed(viewport);
        return state.lines.some((line) => line.includes(`_MAIN_${mode}__`));
      }, "main screen receives new output after gap");
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_MAIN_${mode}__`)), "viewport follows live output after gap");
      const screen = await viewport.innerText();
      assert.ok(screen.includes(`_TAIL_${mode}__`), `switching to the main buffer must retain the replayed tail (${mode}): ${screen}`);
      assert.doesNotMatch(screen, new RegExp(`_ALT_${mode}__`));
    }
    assert.equal(await page.getByTestId("notices").textContent(), "部分终端输出已超出保留范围\n部分终端输出已超出保留范围");
    console.log("PASS: evicted output recovers on drawer reopen and automatic SSE reconnect");
  }

  const connections = streams.length;
  const count = manager.listForProject(projectId).length;
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  await page.getByRole("button", { name: "纸白", exact: true }).click();
  await page.getByRole("button", { name: "16 像素", exact: true }).click();
  await waitFor(() => page.locator(".project-terminal").evaluate((element) => getComputedStyle(element).backgroundColor === "rgb(245, 242, 235)"), "paper theme applied");
  if (zsh) {
    await waitFor(() => sizes.get(first)?.theme === "paper", "paper palette synced to the PTY");
    manager.write(first, projectId, "printf '\\033]11;?\\007'; IFS= read -rst 2 -d '\\' reply; case $reply in (*rgb:f5f5/f2f2/ebeb*) printf '\\r\\n\\137PALETTE_OK__\\n';; esac\r");
    await waitFor(() => outputOf(first).includes("_PALETTE_OK__\r\n"), "OSC color query uses the active palette");
  }
  await page.keyboard.press("Escape");
  assert.equal(manager.get(first, projectId).exitCode, null);
  assert.equal(streams.length, connections);
  assert.equal(manager.listForProject(projectId).length, count);
  await page.screenshot({ path: "/tmp/navi-terminal-paper.png" });
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  await page.getByRole("button", { name: "午夜", exact: true }).click();
  await page.getByRole("button", { name: "14 像素", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/navi-terminal-midnight.png" });
  if (count > 1) {
    await input.focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await waitFor(() => manager.get(first, projectId)?.exitCode !== null, "shell exited");
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).waitFor();
    const before = await page.evaluate((sessionId) => window.__terminalOpens.filter((url) => url.includes(sessionId)).length, first);
    await page.getByRole("button", { name: /^交互验证 2（/ }).click();
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).click();
    await waitFor(() => page.evaluate(({ sessionId, before }) => window.__terminalOpens.filter((url) => url.includes(sessionId)).length > before, { sessionId: first, before }), "ended shell reattached");
    await page.getByRole("button", { name: /^交互验证（已退出）/ }).waitFor();
    console.log("PASS: exited shell stays exited after reconnecting");
  }
  await settleTerminalRequests();
  await page.reload();
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await page.getByRole("button", { name: "终端外观", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "午夜", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: "14 像素", exact: true }).getAttribute("aria-pressed"), "true");
  await page.setViewportSize({ width: 375, height: 700 });
  assert.ok(await page.locator(".terminal-appearance__panel").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth;
  }));
  await settleTerminalRequests();
  assert.equal(await page.getByTestId("notices").textContent(), "");
  assert.deepEqual(errors, []);
  console.log("PASS: terminal key ownership, themes, font sizes, persistence, narrow layout, no session recreation");
}
