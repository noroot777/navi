import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import headless from "@xterm/headless";
import type { TerminalScreenFrame, TerminalScreenUpdate } from "@navi/shared/terminal-screen";
import { terminalScreenStream } from "../src/terminal-screen-stream.ts";
import { createTerminalScreen } from "../src/terminal-screen.ts";

const terminal = new headless.Terminal({ cols: 80, rows: 12, allowProposedApi: true });
const screen = createTerminalScreen(terminal, () => "graphite", () => []);
const app = new Hono().get("/", (context) => terminalScreenStream(context, screen));
const start = "\x1b[?2026h";
const end = "\x1b[?2026l";
const clear = "\x1b[2J\x1b[H";
const replies: string[] = [];
terminal.onData((reply) => replies.push(reply));
const seen: TerminalScreenUpdate[] = [];
const unsubscribe = screen.subscribe((update) => seen.push(update));
const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, () => {
  screen.schedule();
  resolve();
}));
function textOf(frame: TerminalScreenFrame) {
  return frame.lines.map(([, line]) => {
    const cells = Buffer.from(line.cells, "base64");
    let text = "";
    for (let offset = 0; offset < cells.length; offset += 12) {
      const code = cells.readUInt32LE(offset) & 0x1fffff;
      if (code) text += String.fromCodePoint(code);
    }
    return text;
  }).join("\n");
}

const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
async function connect() {
  const response = await app.request("/");
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  readers.push(reader);
  return reader;
}
async function readUpdate(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<TerminalScreenUpdate> {
  while (true) {
    const { value, done } = await reader.read();
    assert.ok(!done);
    const event = new TextDecoder().decode(value);
    if (event.startsWith("event: ping")) continue;
    return JSON.parse(event.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
  }
}

try {
  await write("\x1b]8;;https://example.test/before\x1b\\VISIBLE\x1b]8;;\x1b\\\x1b[?20");
  await write("26h" + clear + "UNFINISHED\x1b[6n");
  const held = screen.snapshot();
  assert.match(textOf(held.frame), /VISIBLE/);
  assert.doesNotMatch(textOf(held.frame), /UNFINISHED/);
  assert.deepEqual(held.frame.links.map(([, uri]) => uri), ["https://example.test/before"]);
  assert.deepEqual(replies, ["\x1b[1;11R"]);
  const slow = await connect();
  assert.deepEqual(await readUpdate(slow), JSON.parse(JSON.stringify(held)));
  assert.equal(held.input.hasScrollback, true);
  const withMouse = "\x1b[?1;66;2004;1000;1006h";
  const resetMouseAndKeys = "\x1b[?1;66;2004;1000;1006l";
  await write("\x1b[?1049h" + withMouse + "UNFINISHED-ALT");
  const live = await readUpdate(slow);
  assert.equal(live.frame, undefined, "input changes do not advance the displayed frame");
  assert.deepEqual(live.input, {
    applicationCursorKeys: true, applicationKeypad: true, bracketedPasteMode: true,
    mouseProtocol: "VT200", mouseEncoding: "SGR", hasScrollback: false,
  });
  await delay(50);
  assert.equal(seen.at(-1)?.revision, live.revision, "no new frame during the transaction");
  const reconnected = await connect();
  assert.deepEqual(await readUpdate(reconnected), JSON.parse(JSON.stringify({ ...live, frame: held.frame })),
    "reconnect gets unchanged committed cells and links plus current input modes");
  await reconnected.cancel();

  await write("\x1b[?1049l" + end);
  for (const label of ["COMMITTED-ONE", "COMMITTED-TWO", "COMMITTED-THREE", "COMMITTED-FOUR"]) {
    await write(clear + label);
    assert.match(textOf(screen.snapshot().frame), new RegExp(label));
  }
  await write(start + resetMouseAndKeys + clear + "UNFINISHED-SECOND");
  const catchup = screen.snapshot();
  const received: TerminalScreenUpdate[] = [];
  do {
    received.push(await readUpdate(slow));
  } while (received.at(-1)!.revision < catchup.revision);
  const receivedFrames = received.flatMap(({ frame }) => frame ? [frame] : []);
  assert.ok(receivedFrames.some((frame) => frame.full), "slow stream coalesces pending deltas into a snapshot");
  assert.equal(receivedFrames.at(-1)?.seq, catchup.frame.seq);
  assert.match(textOf(receivedFrames.at(-1)!), /COMMITTED-FOUR/);
  assert.ok(receivedFrames.every((frame) => !textOf(frame).includes("UNFINISHED")));
  assert.deepEqual(received.at(-1)?.input, held.input, "catch-up sends reset modes even while the next draw is frozen");

  await write(clear + "COMMITTED-FIVE" + end + start + clear + "TIMEOUT-FALLBACK");
  assert.match(textOf(screen.snapshot().frame), /COMMITTED-FIVE/, "same-chunk commit and begin preserves the committed frame");
  const timeout = await new Promise<TerminalScreenFrame>((resolve, reject) => {
    const stop = screen.subscribe(({ frame }) => {
      if (!frame) return;
      stop();
      clearTimeout(deadline);
      resolve(frame);
    });
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("synchronized output never timed out"));
    }, 2500);
  });
  assert.match(textOf(timeout), /TIMEOUT-FALLBACK/);

  await write(start + clear + "FINAL-ON-EXIT");
  assert.doesNotMatch(textOf(screen.snapshot().frame), /FINAL-ON-EXIT/);
  screen.finish(7);
  const { frame: ended } = screen.snapshot();
  assert.match(textOf(ended), /FINAL-ON-EXIT/);
  assert.equal(ended.exitCode, 7);
  assert.equal(seen.at(-1)?.frame?.seq, ended.seq, "exit publishes the final screen to live viewers");
  console.log("PASS: live, resumed and slow streams keep input modes current without exposing uncommitted frames");
} finally {
  screen.finish(1);
  unsubscribe();
  await Promise.all(readers.map((reader) => reader.cancel()));
  terminal.dispose();
}
