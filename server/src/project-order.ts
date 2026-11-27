// 项目的先后：个人设置 `projectOrder`（shared/src/app-settings.ts）。
//
// 排序做在服务端 `GET /projects` 出门之前，而不是让各端拿设置自己排：网页的切换下拉、任务模式按
// 项目分组、手机、飞书里的项目列表读的都是这一份列表，各排各的必有一处跟不上。
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projectOrderIntents, projects } from "./db/schema.js";
import { bus } from "./bus.js";
import { actorOf, authErrorResponse, ownerIdOf } from "./auth/context.js";
import { writePersonalSettings } from "./auth/personal-settings.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { parseAppSettingsPatch } from "./app-settings.js";

export { orderProjects } from "@navi/shared/project";

// 同一个页面的先后意图带着递增的序号来（page + seq）：页面保存超时后会接着发更新的那一份，被它掐掉
// 的旧请求可能滞留在代理或网络里、晚些才到 —— 按（人, 页面）只认序号更大的。记录进库，和顺序在同一个
// 事务里读写（db/schema-project-order-intents.ts）：重启不失忆，也不会「序号记下了、顺序没写」。
// 不带这两项的调用方（脚本、老页面）不受这道闸。
const KEEP_PAGES = 200;
type Intent = { page: string; seq: number };
type OrderTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function intentOf(page: unknown, seq: unknown): Intent | null {
  if (typeof page !== "string" || !page || page.length > 64 || typeof seq !== "number" || !Number.isSafeInteger(seq)) return null;
  return { page, seq };
}

/** 这份意图还算数吗（没有比它更新的同页意图被接受过）。算数就记下它，并只留这个人最近的若干页。 */
async function claimIntent(tx: OrderTx, owner: string, intent: Intent): Promise<boolean> {
  const seen = (await tx.select({ seq: projectOrderIntents.seq }).from(projectOrderIntents)
    .where(and(eq(projectOrderIntents.owner, owner), eq(projectOrderIntents.page, intent.page)))).at(0);
  if (seen && seen.seq >= intent.seq) return false;
  const at = Date.now();
  await tx.insert(projectOrderIntents).values({ owner, ...intent, at })
    .onConflictDoUpdate({ target: [projectOrderIntents.owner, projectOrderIntents.page], set: { seq: intent.seq, at } });
  const keep = tx.select({ page: projectOrderIntents.page }).from(projectOrderIntents)
    .where(eq(projectOrderIntents.owner, owner)).orderBy(desc(projectOrderIntents.at)).limit(KEEP_PAGES);
  // 同一毫秒里记下的几页谁先谁后说不清：刚记下的这一页无论如何不能被裁掉。
  await tx.delete(projectOrderIntents).where(and(eq(projectOrderIntents.owner, owner),
    ne(projectOrderIntents.page, intent.page), notInArray(projectOrderIntents.page, keep)));
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
      const intent = intentOf(body.page, body.seq);
      const owner = ownerIdOf(actor) ?? "";
      const written = await db.transaction(async (tx) => {
        if (intent && !(await claimIntent(tx, owner, intent))) return false;
        await writePersonalSettings(actor, patch, tx);
        return true;
      });
      if (!written) return c.json({ projectOrder, stale: true });
      bus.publish({ type: "projects.reordered", ownerUserId: ownerIdOf(actor) });
      return c.json({ projectOrder });
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
