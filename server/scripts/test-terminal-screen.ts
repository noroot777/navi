import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import headless from "@xterm/headless";
import type { TerminalScreenFrame } from "@navi/shared/terminal-screen";
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
const seen: TerminalScreenFrame[] = [];
const unsubscribe = screen.subscribe((frame) => seen.push(frame));
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
async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<TerminalScreenFrame> {
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
  assert.match(textOf(held), /VISIBLE/);
  assert.doesNotMatch(textOf(held), /UNFINISHED/);
  assert.deepEqual(held.links.map(([, uri]) => uri), ["https://example.test/before"]);
  assert.deepEqual(replies, ["\x1b[1;11R"]);
  const heldOnWire = JSON.parse(JSON.stringify(held));
  const slow = await connect();
  assert.deepEqual(await readFrame(slow), heldOnWire);
  await delay(50);
  assert.equal(seen.at(-1)?.seq, held.seq, "no live frame during the transaction");
  const reconnected = await connect();
  assert.deepEqual(await readFrame(reconnected), heldOnWire, "reconnect gets the same committed cells and links");
  await reconnected.cancel();

  for (const label of ["COMMITTED-ONE", "COMMITTED-TWO", "COMMITTED-THREE", "COMMITTED-FOUR"]) {
    await write(clear + label + end);
    assert.match(textOf(screen.snapshot()), new RegExp(label));
  }
  await write(start + clear + "UNFINISHED-SECOND");
  const catchup = screen.snapshot();
  const received: TerminalScreenFrame[] = [];
  do {
    received.push(await readFrame(slow));
  } while (received.at(-1)!.seq < catchup.seq);
  assert.ok(received.some((frame) => frame.full), "slow stream coalesces pending deltas into a snapshot");
  assert.equal(received.at(-1)?.seq, catchup.seq);
  assert.match(textOf(received.at(-1)!), /COMMITTED-FOUR/);
  assert.ok(received.every((frame) => !textOf(frame).includes("UNFINISHED")));

  await write(clear + "COMMITTED-FIVE" + end + start + clear + "TIMEOUT-FALLBACK");
  assert.match(textOf(screen.snapshot()), /COMMITTED-FIVE/, "same-chunk commit and begin preserves the committed frame");
  const timeout = await new Promise<TerminalScreenFrame>((resolve, reject) => {
    const stop = screen.subscribe((frame) => {
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
  assert.equal(timeout.modes.synchronizedOutput, false);

  await write(start + clear + "FINAL-ON-EXIT");
  assert.doesNotMatch(textOf(screen.snapshot()), /FINAL-ON-EXIT/);
  screen.finish(7);
  const ended = screen.snapshot();
  assert.match(textOf(ended), /FINAL-ON-EXIT/);
  assert.equal(ended.exitCode, 7);
  assert.equal(ended.modes.synchronizedOutput, false);
  assert.equal(seen.at(-1)?.seq, ended.seq, "exit publishes the final screen to live viewers");
  console.log("PASS: synchronized output holds live and resumed screens, coalesces slow streams, and commits on end, timeout or exit");
} finally {
  screen.finish(1);
  unsubscribe();
  await Promise.all(readers.map((reader) => reader.cancel()));
  terminal.dispose();
}
