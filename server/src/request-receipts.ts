// 按请求号只执行一次：带 `x-navi-request-id` 的写请求（navi MCP 每次调用都带，重试原样带上）先在库里
// 落一行「开始执行了」，处理完补上答复。
//
// 要解决的是「送到了一半」：服务在处理一次调用时被停掉（为重启而停、被强杀、排空等超时），或者处理完了、
// 响应没写出去，调用方只看到连接断了。它不知道执行了没有，不重试就丢了交卷，盲目重试就会把 dispatch 这类
// 做两遍。带着同一个请求号重试到（新）服务上时，这里按那一行处置：
//  · 答过了            原样回放记下的那份答复，不再执行
//  · 同一进程正在处理    等它处理完再回放（连接被别的东西掐断、调用方先重试过来了）
//  · 开始了、没答完     上一份服务执行到一半停掉了。业务那一笔和这里的答复是分两次落库的，中间那条缝里
//                      停掉的，业务可能已经做了：
//                        - 业务提交时在同一个事务里写下了答复（`effect`，markRequestEffect）→ 回放它
//                        - 端点自己能按请求号认出做过的那一笔（RECOVERABLE，逐条理由见那里）→ 重新进端点，
//                          做过的由端点交回同一份结果，没做的照常做
//                        - 其余 → 如实答「不确定」，不替调用方赌
//  · 没有这一行         压根没执行过，照常执行
// 「这几个端点写的是同一个值，重做一遍结果不变」**不成立**（第 1 轮审查 F1）：完成、暂停会当场交出只能领一次
// 的哨兵结果，暂停写检查点会让占用代次 +1。所以能重进的只有按请求号认得出自己做过什么的端点。
//
// 读请求不记账（重试无害），只回账本号，让 MCP 早早知道这份服务记账（mcp/src/runtime.ts 据此才敢重试
// 「送到了一半」的写请求；重试之前再核对一次对面还是同一本账）。
//
// 挂在身份与资源闸之后（main.ts）：被它们拒掉的请求没执行，不该占一个请求号。比它更早拒掉的「未执行」
// 503（运行时切换、正在停止、初始化中）同理不进账。
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import { NAVI_HEADERS, readHeader } from "@navi/shared/http-headers";
import { actorOf } from "./auth/context.js";
import { INSTANCE_ID } from "./instance-binding.js";

// 库按需才开：main.ts 静态引这个模块，而那边的约定是会开库的模块等拿到单例锁、初始化时再加载。
type Statement = { sql: string; args: (string | number | null)[] };
const execute = async (statement: Statement) => (await import("./db/index.js")).dbClient.execute(statement);

const KEEP_MS = 24 * 60 * 60_000;
const VALID_ID = /^[A-Za-z0-9_-]{8,128}$/;
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 执行到一半被停掉之后，可以带同一个请求号重新进的端点。每一条都得按请求号认得出自己做过的那一笔：
 *  · complete  交出哨兵结果那一笔把请求号写在同一条认领语句里（monitor-turn-handoff.ts），重进时交回同一份；
 *              落确认那一笔是给同一列写一个时刻、清掉系统自己写的等待，重做结果不变
 *  · pause     交出哨兵结果同上；写检查点那一笔在同一个事务里写下答复（task-resume-prompt.ts），走不到这里
 *  · ask       挂问题那一笔在同一个事务里写下答复（task-question.ts），走不到这里
 *  · stage     阶段与自由审查结论那一笔都在同一个事务里写下答复（task-stage.ts、free-workflow.ts），走不到这里
 * 「同一个事务里写下答复」的那几条，走到这里就说明业务那一笔没提交（提交了答复一定在），重进就是第一次做。
 * 其余端点不在这里：没有这样的凭据，重进可能做第二遍。
 */
const RECOVERABLE = /^\/api\/tasks\/[^/]+\/(?:complete|pause|ask|stage)$/;

export const REQUEST_OUTCOME_UNKNOWN = "这次调用在上一份服务停下时还没处理完，执行到哪一步不确定，没有替你重做："
  + "先核对现状（如 get_task）再决定要不要重新发起";

export const WRONG_LEDGER = "这次调用当初记在另一本账上，重试打到的服务换了一份库，这里没有执行它；原来那一次执行了没有不确定："
  + "先核对现状（如 get_task）再决定要不要重新发起";

type Stored = { fingerprint: string; status: number | null; contentType: string | null; body: string | null; effect: string | null };

/** 同一个请求号在本进程里正在处理：后来的等它处理完再看账。 */
const running = new Map<string, Promise<void>>();
let prunedAt = 0;
let ledger: Promise<string> | null = null;

/** 这本账的号（随库走，见 schema-request-receipts.ts）。 */
function ledgerId(): Promise<string> {
  ledger ??= execute({ sql: "SELECT value FROM app_settings WHERE key = 'request_receipt_ledger'", args: [] })
    .then((result) => String(result.rows[0]?.value ?? INSTANCE_ID));
  return ledger;
}

/** 这一笔业务是哪一次调用发起的、写成了要答什么：答复跟这一笔在同一个事务里落库（markRequestEffect）。 */
export type RequestEffect = { request: string | null | undefined; answer: unknown };

/**
 * 业务那一笔提交时调，传它自己的事务：答复跟业务一起落库，提交了就一定在。不是带请求号进来的（请求号为空、
 * 或者不是经这道中间件进来的）什么都不写。
 */
export async function markRequestEffect(
  transaction: { run: (query: ReturnType<typeof sql>) => Promise<unknown> },
  requestId: string | null | undefined,
  answer: unknown,
): Promise<void> {
  if (!requestId) return;
  await transaction.run(sql`UPDATE request_receipts SET effect = ${JSON.stringify(answer)} WHERE request_id = ${requestId}`);
}

function fingerprintOf(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function load(id: string): Promise<Stored | null> {
  const row = (await execute({
    sql: "SELECT fingerprint, status, content_type, body, effect FROM request_receipts WHERE request_id = ?", args: [id],
  })).rows[0];
  if (!row) return null;
  const text = (value: unknown) => (value === null ? null : String(value));
  return {
    fingerprint: String(row.fingerprint),
    status: row.status === null ? null : Number(row.status),
    contentType: text(row.content_type),
    body: text(row.body),
    effect: text(row.effect),
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

async function answer(id: string, status: number, contentType: string | null, body: string): Promise<void> {
  await execute({
    sql: "UPDATE request_receipts SET status = ?, content_type = ?, body = ?, answered_at = ? WHERE request_id = ?",
    args: [status, contentType, body, new Date().toISOString(), id],
  });
}

async function replay(stored: Pick<Stored, "status" | "contentType" | "body">): Promise<Response> {
  return new Response(stored.body, {
    status: stored.status!,
    headers: {
      "content-type": stored.contentType ?? "application/json",
      [NAVI_HEADERS.requestReceipt]: await ledgerId(),
      [NAVI_HEADERS.requestReplayed]: "1",
    },
  });
}

export function requestReceipts(): MiddlewareHandler {
  return async (c, next) => {
    const id = readHeader((name) => c.req.header(name), NAVI_HEADERS.requestId);
    if (!id) return next();
    if (!VALID_ID.test(id)) return c.json({ error: "请求号格式不对，请求未执行" }, 400);
    // 重发的调用带着它当初记在哪本账上（mcp/src/runtime.ts）：不是这一本，这里没有它的记录，执行就可能是第二遍。
    const expected = readHeader((name) => c.req.header(name), NAVI_HEADERS.requestLedger);
    if (expected && !READS.has(c.req.method) && expected !== await ledgerId()) {
      c.header(NAVI_HEADERS.requestReceipt, await ledgerId());
      return c.json({ error: WRONG_LEDGER, outcome: "unknown" }, 409);
    }
    if (READS.has(c.req.method)) {
      await next();
      c.header(NAVI_HEADERS.requestReceipt, await ledgerId());
      return;
    }
    const url = new URL(c.req.url);
    const target = url.pathname + url.search;
    const header = (name: (typeof NAVI_HEADERS)[keyof typeof NAVI_HEADERS]) => readHeader((key) => c.req.header(key), name) ?? "";
    const actor = actorOf(c);
    // 前面的闸读过正文的话原始请求已经被读空，从 Hono 的正文缓存里取；没读过就复制一份读，不动原件。
    const raw = c.req.raw.bodyUsed ? await c.req.arrayBuffer() : await c.req.raw.clone().arrayBuffer();
    // 同一个请求号只认同一个请求：方法、地址、正文、回合与方向身份、发请求的人，换了哪一样都不是重试。
    const fingerprint = fingerprintOf([c.req.method, target,
      createHash("sha256").update(Buffer.from(raw)).digest("hex"),
      header(NAVI_HEADERS.sourceTaskId), header(NAVI_HEADERS.turnToken), header(NAVI_HEADERS.directionToken),
      `${actor.kind}:${actor.userId ?? ""}`]);
    for (let earlier = running.get(id); earlier; earlier = running.get(id)) await earlier;
    let release!: () => void;
    running.set(id, new Promise<void>((resolve) => { release = resolve; }));
    try {
      const stored = await load(id);
      if (stored && stored.fingerprint !== fingerprint) {
        return c.json({ error: "这个请求号已经用在另一个请求上，请求未执行" }, 409);
      }
      if (stored?.status != null) return replay(stored);
      if (stored?.effect != null) {
        // 业务提交了、答复没来得及记：记下的就是业务提交时写的那份。
        await answer(id, 200, "application/json", stored.effect);
        return replay({ status: 200, contentType: "application/json", body: stored.effect });
      }
      if (stored && !RECOVERABLE.test(url.pathname)) {
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
        await answer(id, response.status, response.headers.get("content-type"), await response.clone().text());
        c.header(NAVI_HEADERS.requestReceipt, await ledgerId());
      } catch (error) {
        // 记不下答复不拦这一次的答复，也不回账本号（这一次没记账）。之后带同一个请求号重试过来，按「没答完」处置。
        console.warn(`[navi] 请求回执没记下（${c.req.method} ${url.pathname}）:`, error);
      }
    } finally {
      running.delete(id);
      release();
    }
  };
}
