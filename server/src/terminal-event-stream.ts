import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { TerminalSessionManager } from "./terminal.js";
import type { TerminalEvent } from "./terminal-session-facts.js";

export function terminalEventStream(context: Context, manager: TerminalSessionManager, projectId: string, sessionId: string) {
  const after = Number(context.req.header("last-event-id") ?? context.req.query("after") ?? 0) || 0;
  const replay = manager.eventsAfter(sessionId, projectId, after);
  if (!replay) return context.json({ error: "terminal session not found" }, 404);
  return streamSSE(context, async (stream) => {
    let pending: TerminalEvent[] | null = [];
    const write = (event: TerminalEvent) => stream.writeSSE({
      id: String(event.seq),
      data: JSON.stringify(event),
    });
    const unsubscribe = manager.subscribe(sessionId, projectId, (event) => {
      if (pending) pending.push(event);
      else void write(event).catch(() => undefined);
    });
    stream.onAbort(() => unsubscribe?.());
    try {
      for (const event of replay) {
        if (stream.aborted) return;
        await write(event);
      }
      for (const event of pending) {
        if (stream.aborted) return;
        await write(event);
      }
      pending = null;
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "1" });
        await stream.sleep(15_000);
      }
    } finally {
      unsubscribe?.();
    }
  });
}
