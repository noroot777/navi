import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { TerminalScreenFrame } from "@navi/shared/terminal-screen";
import type { TerminalScreen } from "./terminal-screen.js";

export function terminalScreenStream(context: Context, screen: TerminalScreen) {
  return streamSSE(context, async (stream) => {
    let writing = false;
    let dirty = false;
    let sent = -1;
    const write = async (first: TerminalScreenFrame) => {
      writing = true;
      try {
        let frame = first;
        while (!stream.aborted && frame.seq > sent) {
          dirty = false;
          sent = frame.seq;
          await stream.writeSSE({ id: String(frame.seq), data: JSON.stringify(frame) });
          if (!dirty) break;
          frame = screen.snapshot();
        }
      } finally {
        writing = false;
      }
    };
    const initial = screen.snapshot();
    const stop = screen.subscribe((frame) => {
      if (writing) dirty = true;
      else void write(frame).catch(() => undefined);
    });
    stream.onAbort(stop);
    try {
      await write(initial);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "1" });
        await stream.sleep(15_000);
      }
    } finally {
      stop();
    }
  });
}
