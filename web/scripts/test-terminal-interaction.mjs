import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessionManager } from "../../server/src/terminal.ts";
import { terminalInputChunks } from "../src/workspace/terminalInput.ts";
import { launchChrome } from "./dom-stage.mjs";
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
  writeFileSync(join(scratch, ".zshrc"), "unset HISTFILE\nbindkey -M viins '^H' backward-kill-word\n");
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
  const after = Number(lastEventId ?? context.req.query("after") ?? 0);
  streams.push({ sessionId, after, lastEventId });
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
      inputs.push({ sessionId, data: body.data });
      if (Buffer.byteLength(body.data) > 64 * 1024) return json({ error: "data too large" }, 413);
      manager.write(sessionId, projectId, body.data);
      return json({});
    }
    if (action === "resize") {
      sizes.set(sessionId, body);
      manager.resize(sessionId, projectId, body.cols, body.rows);
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__terminalOpens = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        this.addEventListener("open", () => window.__terminalOpens.push(String(url)));
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
    console.error("SCREEN", (await viewport.innerText()).slice(-2500));
    console.error("ERRORS", errors);
    await page.screenshot({ path: "/tmp/navi-terminal-failure.png" });
    throw new Error(`Timed out: ${description}`);
  };
  await waitFor(() => manager.listForProject(projectId).length === 1, "shell created");
  const first = manager.listForProject(projectId)[0].id;
  await waitFor(() => outputOf(first).length > 0, "shell prompt");
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
    await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
    assert.equal(await page.locator(".project-terminal").isVisible(), false);
    await page.getByRole("button", { name: "终端", exact: true }).click();
    await waitFor(() => streams.some((entry) => entry.sessionId === first && entry.after > 0), "drawer preserves alternate screen");
    await page.getByRole("button", { name: "新建 CLI" }).click();
    await waitFor(() => manager.listForProject(projectId).length === 2, "second shell created");
    await page.getByRole("button", { name: /^交互验证（/ }).click();
    await waitFor(() => streams.some((entry) => entry.sessionId === first && entry.after > 0), "resume without replaying old screen");
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
    assert.match(inputs.slice(beforeLiveQuery).map((entry) => entry.data).join(""), /\x1b\[\?12;\d+\$y/);

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
        streamResponses.get(first).destroy();
      } else {
        await page.getByRole("button", { name: "收起终端（shell 与服务继续跑）" }).click();
      }
      manager.write(first, projectId, "\r");
      await waitFor(() => outputOf(first).includes(`\r\n_TAIL_${mode}__\r\n`), "output exceeded replay buffer");
      assert.ok(manager.eventsAfter(first, projectId, 0)[0].seq > lastBeforeGap + 1);
      if (!automatic) await page.getByRole("button", { name: "终端", exact: true }).click();
      await waitFor(() => streams.slice(streamCount).some((entry) => entry.sessionId === first && entry.after > 0 && (!automatic || entry.lastEventId)), "cursor sent on resumed stream");
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_TAIL_${mode}__`)), "retained tail rendered");
      await waitFor(() => input.isEditable(), "input enabled after truncated replay");
      await input.focus();
      await page.keyboard.type(`printf '\\033[?1047l\\137MAIN_${mode}__\\n'`);
      await page.keyboard.press("Enter");
      await waitFor(() => viewport.innerText().then((text) => text.includes(`_MAIN_${mode}__`)), "main screen remains usable after gap");
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
  assert.equal(await page.getByTestId("notices").textContent(), "");
  assert.deepEqual(errors, []);
  console.log("PASS: terminal key ownership, themes, font sizes, persistence, narrow layout, no session recreation");
}
