// ── 项目先后：每人一个顺序版本号 ─────────────────────────────────────────────────
// 每写一次这个人的项目先后就加一(server/src/project-order.ts)。页面保存前先读它，带着去写，对不上就不写：
// 保存超时后被掐掉的旧请求可能滞留在代理或网络里、晚些才到，它带的版本号早已过时，一律作废 ——
// 不管晚到多久、中间开过多少页面、服务重启过没有。只存一个数，不用按页面记、也不用裁。
// 和顺序在同一个事务里读写，所以进库：只在内存里记，重启一清就认不出旧请求了。
//
// owner：多人模式下是 userId；自用模式下是空串（主键里不能用 NULL，理由同 schema-task-reads.ts）。
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

export const projectOrderRevisions = sqliteTable("project_order_revisions", {
  owner: text("owner").primaryKey(),
  rev: integer("rev").notNull(),
});

/** 建表(幂等,每次启动都跑)。 */
export async function ensureProjectOrderRevisionsSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS project_order_revisions (owner TEXT PRIMARY KEY, rev INTEGER NOT NULL);
  `);
}
