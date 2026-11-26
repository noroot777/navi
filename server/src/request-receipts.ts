// 按请求号只执行一次：带 `x-navi-request-id` 的写请求（navi MCP 每次调用都带，重试原样带上）先在库里
// 落一行「开始执行了」，处理完补上答复。
//
// 要解决的是「送到了一半」：服务在处理一次调用时被停掉（为重启而停、被强杀、排空等超时），或者处理完了、
// 响应没写出去，调用方只看到连接断了。它不知道执行了没有，不重试就丢了交卷，盲目重试就会把 dispatch 这类
// 做两遍。带着同一个请求号重试到（新）服务上时，这里按那一行处置：
//  · 答过了          原样回放记下的那份答复，不再执行
//  · 同一进程正在处理  等它处理完再回放（连接被别的东西掐断、调用方先重试过来了）
//  · 开始了、没答完   上一份服务执行到一半停掉了，做到哪一步不知道：交卷端点（isTurnReportPath，写回同一个
//                    值，重做一遍结果不变）重做；其余如实答「不确定」，不替调用方赌
//  · 没有这一行       压根没执行过，照常执行
// 读请求不记账（重试无害），只回回执头，让 MCP 早早知道这份服务记账（它据此才敢重试「送到了一半」的写请求）。
//
// 挂在身份与资源闸之后（main.ts）：被它们拒掉的请求没执行，不该占一个请求号。比它更早拒掉的「未执行」
// 503（运行时切换、正在停止、初始化中）同理不进账。
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { NAVI_HEADERS, readHeader } from "@navi/shared/http-headers";
import { isTurnReportPath } from "@navi/shared/mcp-delivery";
import { INSTANCE_ID } from "./instance-binding.js";

// 库按需才开：main.ts 静态引这个模块，而那边的约定是会开库的模块等拿到单例锁、初始化时再加载。
type Statement = { sql: string; args: (string | number | null)[] };
const execute = async (statement: Statement) => (await import("./db/index.js")).dbClient.execute(statement);

const KEEP_MS = 24 * 60 * 60_000;
const VALID_ID = /^[A-Za-z0-9_-]{8,128}$/;
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export const REQUEST_OUTCOME_UNKNOWN = "这次调用在上一份服务停下时还没处理完，执行到哪一步不确定，没有替你重做："
  + "先核对现状（如 get_task）再决定要不要重新发起";

type Stored = { fingerprint: string; status: number | null; contentType: string | null; body: string | null };

/** 同一个请求号在本进程里正在处理：后来的等它处理完再看账。 */
const running = new Map<string, Promise<void>>();
let prunedAt = 0;

function fingerprintOf(method: string, target: string, sourceTask: string, turnToken: string): string {
  return createHash("sha256").update([method, target, sourceTask, turnToken].join("\n")).digest("hex");
}

async function load(id: string): Promise<Stored | null> {
  const row = (await execute({
    sql: "SELECT fingerprint, status, content_type, body FROM request_receipts WHERE request_id = ?", args: [id],
  })).rows[0];
  if (!row) return null;
  return {
    fingerprint: String(row.fingerprint),
    status: row.status === null ? null : Number(row.status),
    contentType: row.content_type === null ? null : String(row.content_type),
    body: row.body === null ? null : String(row.body),
  };
}

async function begin(id: string, fingerprint: string, method: string, target: string): Promise<void> {
  const now = Date.now();
  if (now - prunedAt > 60 * 60_000) {
    prunedAt = now;
    await execute({ sql: "DELETE FROM request_receipts WHERE started_at < ?", args: [new Date(now - KEEP_MS).toISOString()] });
  }
  await execute({
    sql: "INSERT INTO request_receipts (request_id, fingerprint, method, path, owner, started_at) VALUES (?, ?, ?, ?, ?, ?)"
      + " ON CONFLICT(request_id) DO UPDATE SET owner = excluded.owner, started_at = excluded.started_at",
    args: [id, fingerprint, method, target, INSTANCE_ID, new Date(now).toISOString()],
  });
}

function replay(stored: Stored): Response {
  return new Response(stored.body, {
    status: stored.status!,
    headers: { "content-type": stored.contentType ?? "application/json", [NAVI_HEADERS.requestReceipt]: "replayed" },
  });
}

export function requestReceipts(): MiddlewareHandler {
  return async (c, next) => {
    const id = readHeader((name) => c.req.header(name), NAVI_HEADERS.requestId);
    if (!id) return next();
    if (!VALID_ID.test(id)) return c.json({ error: "请求号格式不对，请求未执行" }, 400);
    if (READS.has(c.req.method)) {
      await next();
      c.header(NAVI_HEADERS.requestReceipt, "recorded");
      return;
    }
    const url = new URL(c.req.url);
    const target = url.pathname + url.search;
    const fingerprint = fingerprintOf(c.req.method, target,
      readHeader((name) => c.req.header(name), NAVI_HEADERS.sourceTaskId) ?? "",
      readHeader((name) => c.req.header(name), NAVI_HEADERS.turnToken) ?? "");
    for (let earlier = running.get(id); earlier; earlier = running.get(id)) await earlier;
    let release!: () => void;
    running.set(id, new Promise<void>((resolve) => { release = resolve; }));
    try {
      const stored = await load(id);
      if (stored && stored.fingerprint !== fingerprint) {
        return c.json({ error: "这个请求号已经用在另一个请求上，请求未执行" }, 409);
      }
      if (stored?.status != null) return replay(stored);
      if (stored && !isTurnReportPath(url.pathname)) {
        return c.json({ error: REQUEST_OUTCOME_UNKNOWN, outcome: "unknown" }, 409);
      }
      await begin(id, fingerprint, c.req.method, target);
      await next();
      const response = c.res;
      // 里层答了「未执行」、或者是一条推送流（回放不了）：不占这个请求号，下次照常执行。
      if (response.headers.get("x-navi-undelivered") || response.headers.get("content-type")?.startsWith("text/event-stream")) {
        await execute({ sql: "DELETE FROM request_receipts WHERE request_id = ?", args: [id] });
        return;
      }
      try {
        const body = await response.clone().text();
        await execute({
          sql: "UPDATE request_receipts SET status = ?, content_type = ?, body = ?, answered_at = ? WHERE request_id = ?",
          args: [response.status, response.headers.get("content-type"), body, new Date().toISOString(), id],
        });
      } catch (error) {
        // 记不下答复不拦这一次的答复；只是之后带同一个请求号重试过来，会被当成「没答完」。
        console.warn(`[navi] 请求回执没记下（${c.req.method} ${url.pathname}）:`, error);
      }
      c.header(NAVI_HEADERS.requestReceipt, "recorded");
    } finally {
      running.delete(id);
      release();
    }
  };
}
