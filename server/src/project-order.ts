// 项目的先后：个人设置 `projectOrder`（shared/src/app-settings.ts）。
//
// 排序做在服务端 `GET /projects` 出门之前，而不是让各端拿设置自己排：网页的切换下拉、任务模式按
// 项目分组、手机、飞书里的项目列表读的都是这一份列表，各排各的必有一处跟不上。
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { bus } from "./bus.js";
import { actorOf, authErrorResponse, ownerIdOf } from "./auth/context.js";
import { patchSettingsFor } from "./auth/personal-settings.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { parseAppSettingsPatch } from "./app-settings.js";

/** 排过的在前、按排出来的先后；没排过的（新建的、后来才看得见的）接在后面，保持原来的先后。 */
export function orderProjects<T extends { id: string }>(rows: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return [...rows];
  const rank = new Map(order.map((projectId, index) => [projectId, index]));
  return rows
    .map((row, index) => ({ row, key: rank.get(row.id) ?? order.length + index }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.row);
}

export function mountProjectOrderRoutes(api: Hono): void {
  // 整份顺序一次写下（拖完一次就是一份新顺序，不做「把 A 挪到 B 前面」的增量：增量要靠服务端
  // 那份旧顺序拼，两个页面各拖一下就拼出谁都没排过的结果）。只留这个人看得见的项目 id：
  // 删掉的、看不见的写进去也只是占地方。
  api.put("/project-order", async (c) => {
    const actor = actorOf(c);
    try {
      const body = await c.req.json<{ projectIds?: unknown }>();
      if (!Array.isArray(body.projectIds)) return c.json({ error: "projectIds 必须是数组" }, 400);
      const visible = await visibleProjectIds(actor);
      const known = new Set((await db.select({ id: projects.id }).from(projects)).map((row) => row.id));
      const projectOrder = [...new Set(body.projectIds.filter((value): value is string =>
        typeof value === "string" && known.has(value) && (visible === null || visible.has(value))))];
      await patchSettingsFor(actor, parseAppSettingsPatch({ projectOrder }));
      bus.publish({ type: "projects.reordered", ownerUserId: ownerIdOf(actor) });
      return c.json({ projectOrder });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
