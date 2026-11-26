// ── 请求回执：按请求号记下「这次调用执行过没有、答了什么」────────────────────────────
// 读写都在 request-receipts.ts。一次带请求号的写请求进门先落一行（status 为空 = 开始执行了、还没答），
// 处理完补上答复。服务在处理中被停掉、调用方带着同一个请求号重试到新服务上时，凭这一行认出来：答过的
// 原样回放，没答完的按端点处置。所以它必须在库里、跨得过重启，不能只在内存里。
//
// `effect`：业务那一笔提交时、在**同一个事务里**写下的答复（markRequestEffect）。业务落了库、答复还没
// 记进 status/body 就被停掉的那一下，凭它回放 —— 业务与答复分两次落库，中间那条缝只有这样才合得上。
//
// 账本号（app_settings 里的 `request_receipt_ledger`）随库走、只生成一次：MCP 据此认「重试打到的还是
// 记着这本账的服务」（换成不记账的老版本服务就不重试），见 mcp/src/runtime.ts。
//
// 只留一天：重试窗口是秒级的（mcp/src/runtime.ts 的 RECONNECT_WINDOW_MS），一天是给机器睡眠、手动
// 拖延留的余量。
import { randomUUID } from "node:crypto";
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
      answered_at TEXT,
      effect TEXT
    );
    CREATE INDEX IF NOT EXISTS request_receipts_started ON request_receipts(started_at);
  `);
  // 这张表先于 effect 列出现过（同一分支的上一版），那时建的库补上这一列。
  const columns = (await client.execute("PRAGMA table_info(request_receipts)")).rows.map((row) => String(row.name));
  if (!columns.includes("effect")) await client.execute("ALTER TABLE request_receipts ADD COLUMN effect TEXT");
  await client.execute({
    sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('request_receipt_ledger', ?)", args: [randomUUID()],
  });
}
