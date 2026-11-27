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

export { orderProjects } from "@navi/shared/project";

// 同一个页面的先后意图带着递增的序号来（page + seq）：页面保存超时后会接着发更新的那一份，被它掐掉
// 的旧请求万一晚到，不能把顺序盖回去 —— 按（人, 页面）只认序号更大的。只记在内存里：页面 id 每次
// 打开都是新的，重启前在途的旧请求重启后也到不了；不带这两项的调用方（脚本、老页面）不受这道闸。
const SEEN_LIMIT = 500;
const latestSeq = new Map<string, number>();

function claimIntent(owner: string | null, page: unknown, seq: unknown): boolean {
  if (typeof page !== "string" || !page || page.length > 64 || typeof seq !== "number" || !Number.isSafeInteger(seq)) return true;
  const key = `${owner ?? ""}\u0000${page}`;
  const seen = latestSeq.get(key);
  if (seen !== undefined && seq <= seen) return false;
  latestSeq.delete(key);
  latestSeq.set(key, seq);
  if (latestSeq.size > SEEN_LIMIT) latestSeq.delete(latestSeq.keys().next().value!);
  return true;
}

export function mountProjectOrderRoutes(api: Hono): void {
  // 整份顺序一次写下（拖完一次就是一份新顺序，不做「把 A 挪到 B 前面」的增量：增量要靠服务端
  // 那份旧顺序拼，两个页面各拖一下就拼出谁都没排过的结果）。只留这个人看得见的项目 id：
  // 删掉的、看不见的写进去也只是占地方。
  api.put("/project-order", async (c) => {
    const actor = actorOf(c);
    try {
      const body = await c.req.json<{ projectIds?: unknown; page?: unknown; seq?: unknown }>();
      if (!Array.isArray(body.projectIds)) return c.json({ error: "projectIds 必须是数组" }, 400);
      const visible = await visibleProjectIds(actor);
      const known = new Set((await db.select({ id: projects.id }).from(projects)).map((row) => row.id));
      const projectOrder = [...new Set(body.projectIds.filter((value): value is string =>
        typeof value === "string" && known.has(value) && (visible === null || visible.has(value))))];
      const patch = parseAppSettingsPatch({ projectOrder });
      // 认领和写之间不夹别的 await：同页两份请求按认领先后落库，序号小的晚到就直接作废。
      if (!claimIntent(ownerIdOf(actor), body.page, body.seq)) return c.json({ projectOrder, stale: true });
      await patchSettingsFor(actor, patch);
      bus.publish({ type: "projects.reordered", ownerUserId: ownerIdOf(actor) });
      return c.json({ projectOrder });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
