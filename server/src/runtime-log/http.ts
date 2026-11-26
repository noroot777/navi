// 请求那一侧的运行日志：此刻有哪些请求在处理（卡顿那一刻拿出来看是谁），以及特别慢的请求。
//
// 记的是服务端**注册的路由模板**（Hono 的 `c.req.routePath`，如 `/api/tasks/:id/messages`），不是请求
// 路径：模板来自代码里的注册表，任务号、文件名、查询串进不来。请求还没走到具体路由时（卡在前面的鉴权
// 中间件里），拿到的是那一层中间件的模板（`/api/*`、`*`），同样是代码里的常量。
import type { Context, MiddlewareHandler } from "hono";
import { routePattern } from "@navi/shared/runtime-log";
import { runtimeLog } from "./journal.js";

/** 超过这么久的请求记一条 `http.slow`（流式响应不算：它们本来就开着）。 */
const SLOW_MS = 3000;

type Inflight = { context: Context; method: string; start: number };

const inflight = new Map<number, Inflight>();
let seq = 0;
let served = 0;

function routeOf(context: Context): string {
  try {
    return routePattern(context.req.routePath);
  } catch {
    return "?";
  }
}

export function runtimeLogHttp(): MiddlewareHandler {
  return async (c, next) => {
    const id = ++seq;
    const entry: Inflight = { context: c, method: c.req.method, start: performance.now() };
    inflight.set(id, entry);
    served += 1;
    try {
      await next();
    } finally {
      inflight.delete(id);
      const ms = performance.now() - entry.start;
      if (ms >= SLOW_MS && !c.res.headers.get("content-type")?.includes("text/event-stream")) {
        runtimeLog("http.slow", { route: routeOf(c), method: entry.method, ms: Math.round(ms), status: c.res.status });
      }
    }
  };
}

/** 卡顿那一刻在处理的请求，最老的几条。 */
export function inflightSnapshot(limit = 5): Array<{ route: string; method: string; ageMs: number }> {
  const now = performance.now();
  return [...inflight.values()]
    .sort((a, b) => a.start - b.start)
    .slice(0, limit)
    .map((entry) => ({ route: routeOf(entry.context), method: entry.method, ageMs: Math.round(now - entry.start) }));
}

/** 从上次取以来处理过多少个请求（vitals 用）。 */
export function takeServedCount(): { served: number; inflight: number } {
  const out = { served, inflight: inflight.size };
  served = 0;
  return out;
}
