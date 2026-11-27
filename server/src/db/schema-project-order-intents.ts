// ── 项目先后：每个页面最后一次被接受的意图序号 ─────────────────────────────────────
// 页面保存先后时带着 page（打开时随机生成）+ seq（页面里递增），服务端按（人, 页面）只认更大的序号
// (server/src/project-order.ts)。保存超时后页面会接着发更新的那一份，被掐掉的旧请求可能还滞留在代理
// 或网络里、晚些才到 —— 晚到的时候服务端可能已经重启过，所以这份记录得进库，并且和顺序在同一个事务里写：
// 只在内存里记，重启一清，旧请求就重新拿到写入资格。
//
// owner：多人模式下是 userId；自用模式下是空串（主键里不能用 NULL，理由同 schema-task-reads.ts）。
// 每人只留最近的若干页（at = 服务端的钟），更早打开的页面早已没有在途请求。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const projectOrderIntents = sqliteTable(
  "project_order_intents",
  {
    owner: text("owner").notNull(),
    page: text("page").notNull(),
    seq: integer("seq").notNull(),
    at: integer("at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.owner, t.page] }) }),
);

/** 建表(幂等,每次启动都跑)。 */
export async function ensureProjectOrderIntentsSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS project_order_intents (
      owner TEXT NOT NULL, page TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (owner, page)
    );
  `);
}
