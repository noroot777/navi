// ── 请求回执：按请求号记下「这次调用执行过没有、答了什么」────────────────────────────
// 读写都在 request-receipts.ts。一次带请求号的写请求进门先落一行（status 为空 = 开始执行了、还没答），
// 处理完补上答复。服务在处理中被停掉、调用方带着同一个请求号重试到新服务上时，凭这一行认出来：答过的
// 原样回放，没答完的按端点处置。所以它必须在库里、跨得过重启，不能只在内存里。
//
// 只留一天：重试窗口是秒级的（mcp/src/runtime.ts 的 RECONNECT_WINDOW_MS），一天是给机器睡眠、手动
// 拖延留的余量。
import type { Client } from "./node-sqlite-client.js";

export async function ensureRequestReceiptsSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS request_receipts (
      request_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      owner TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status INTEGER,
      content_type TEXT,
      body TEXT,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS request_receipts_started ON request_receipts(started_at);
  `);
}
