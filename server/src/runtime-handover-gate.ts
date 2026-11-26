import type { ServerResponse } from "node:http";
import type { MiddlewareHandler } from "hono";
import { activeRuntimeChannels, runtimeAgentChannel, trackRuntimeChannel } from "./runtime-agent-channels.js";
import { runtimeGatewayIdle } from "./runtime-channel-gateway.js";
import { runtimeHandoverActive, serviceShuttingDown } from "./runtime-handover-state.js";
import { beginRequest, inFlightRequests } from "./inflight-requests.js";

export async function waitRuntimeRequests(timeout = 8_000): Promise<boolean> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (inFlightRequests().length === 0 && activeRuntimeChannels().length === 0 && await runtimeGatewayIdle()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

// 换运行时（handover）和正在停止（shutdown）都在这里关门：新来的 /api 请求一律答「未执行」，
// 带 `x-navi-undelivered`，navi MCP 认得它，退避重试到新服务起来（mcp/src/runtime.ts）。已经进门的
// 照常处理完 —— 封口和退出都先等它们（inflight-requests.ts）。几个问状态、停服务一方要用的接口不关。
export function runtimeHandoverGate(): MiddlewareHandler {
  return async (context, next) => {
    if (!context.req.path.startsWith("/api/") || ["/api/health", "/api/restart-impact", "/api/restart-freeze", "/api/runtime-handover"].includes(context.req.path)) return next();
    const channel = runtimeAgentChannel(context.req.path);
    const closing = serviceShuttingDown();
    if (closing || runtimeHandoverActive()) {
      const what = closing ? "服务正在停止" : "服务正在切换";
      if (channel === "monitor") return context.json({ hookSpecificOutput: { hookEventName: "PreToolUse",
        permissionDecision: "deny", permissionDecisionReason: `${what}，Monitor 未执行，请用 Navi start_monitor` } });
      context.header("x-navi-undelivered", "runtime-handoff-v1");
      if (closing) context.header("connection", "close");
      return context.json({ error: `${what}，请求未执行` }, 503);
    }
    if (!channel) {
      const done = beginRequest(context.req.method, context.req.path);
      // 处理完还不算完：响应交给内核之后才放（理由见 inflight-requests.ts）。拿不到底层响应（测试里
      // 直接调 app.request）、或者是事件推送那种长流，处理函数一返回就放。
      const outgoing = (context.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
      let handed = false;
      try {
        await next();
        const streaming = context.res.headers.get("content-type")?.startsWith("text/event-stream");
        if (outgoing && typeof outgoing.once === "function" && !outgoing.writableFinished && !outgoing.destroyed && !streaming) {
          outgoing.once("finish", done);
          outgoing.once("close", done);
          handed = true;
        }
      } finally { if (!handed) done(); }
      return;
    }
    const finish = trackRuntimeChannel(channel);
    let streaming = false;
    try {
      await next();
      const response = context.res;
      if (!response.body) return;
      const reader = response.body.getReader();
      context.res = new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { finish(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
      streaming = true;
    } finally { if (!streaming) finish(); }
  };
}
