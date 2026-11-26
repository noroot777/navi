// 请求那一侧的运行日志：卡顿那一段时间里在处理的请求（拿出来看是谁），以及特别慢的请求。
//
// 卡顿是事后才量出来的（定时器被堵住、恢复后才发现），同步阻塞的那个请求往往刚好在阻塞结束后就返回了：
// 只看「此刻还在处理的」会正好漏掉它。所以完成的请求留最近一小段，按跟卡顿区间是否重叠来取。
//
// 记的是服务端**注册的路由模板**（Hono 的 `c.req.routePath`，如 `/api/tasks/:id/messages`），不是请求
// 路径：模板来自代码里的注册表，任务号、文件名、查询串进不来。请求还没走到具体路由时（卡在前面的鉴权
// 中间件里），拿到的是那一层中间件的模板（`/api/*`、`*`），同样是代码里的常量。
import type { Context, MiddlewareHandler } from "hono";
import { routePattern, scrubMethod } from "@navi/shared/runtime-log";
import { runtimeLog } from "./journal.js";

/** 超过这么久的请求记一条 `http.slow`（流式响应不算：它们本来就开着）。 */
const SLOW_MS = 3000;

type Inflight = { context: Context; method: string; start: number };
type Finished = { route: string; method: string; start: number; end: number };

const inflight = new Map<number, Inflight>();
/** 最近完成的请求（流式响应不留：它们本来就一直开着）。 */
const finished: Finished[] = [];
const KEEP_FINISHED = 64;
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
    const entry: Inflight = { context: c, method: scrubMethod(c.req.method), start: performance.now() };
    inflight.set(id, entry);
    served += 1;
    try {
      await next();
    } finally {
      inflight.delete(id);
      const end = performance.now();
      const ms = end - entry.start;
      if (!c.res.headers.get("content-type")?.includes("text/event-stream")) {
        const route = routeOf(c);
        finished.push({ route, method: entry.method, start: entry.start, end });
        if (finished.length > KEEP_FINISHED) finished.splice(0, finished.length - KEEP_FINISHED);
        if (ms >= SLOW_MS) runtimeLog("http.slow", { route, method: entry.method, ms: Math.round(ms), status: c.res.status });
      }
    }
  };
}

/**
 * `[fromPerf, toPerf]` 这段时间里在处理的请求：还没完成的，和完成了但跟这段重叠的。最近开始的排前面——
 * 卡顿多半是刚进来的那个请求同步干活，开了很久的长连接排到后面。`ageMs`：从开始到现在（没完成）/ 用了多久（完成了）。
 */
export function requestsDuring(fromPerf: number, toPerf: number, limit = 5): Array<{ route: string; method: string; ageMs: number; done?: true }> {
  const now = performance.now();
  const open = [...inflight.values()].map((entry) => ({ route: routeOf(entry.context), method: entry.method, start: entry.start, ageMs: Math.round(now - entry.start) }));
  const done = finished.filter((entry) => entry.end >= fromPerf && entry.start <= toPerf)
    .map((entry) => ({ route: entry.route, method: entry.method, start: entry.start, ageMs: Math.round(entry.end - entry.start), done: true as const }));
  return [...open, ...done].sort((a, b) => b.start - a.start).slice(0, limit).map(({ start: _start, ...rest }) => rest);
}

/** 从上次取以来处理过多少个请求（vitals 用）。 */
export function takeServedCount(): { served: number; inflight: number } {
  const out = { served, inflight: inflight.size };
  served = 0;
  return out;
}
