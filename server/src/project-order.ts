// 项目的先后：个人设置 `projectOrder`（shared/src/app-settings.ts）。
//
// 排序做在服务端 `GET /projects` 出门之前，而不是让各端拿设置自己排：网页的切换下拉、任务模式按
// 项目分组、手机、飞书里的项目列表读的都是这一份列表，各排各的必有一处跟不上。
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projectOrderRevisions, projects } from "./db/schema.js";
import { bus } from "./bus.js";
import { actorOf, authErrorResponse, ownerIdOf, type Actor } from "./auth/context.js";
import { settingsForActor, writePersonalSettings } from "./auth/personal-settings.js";
import { visibleProjectIds } from "./auth/visibility.js";
import { parseAppSettingsPatch } from "./app-settings.js";

export { orderProjects } from "@navi/shared/project";

// 每写一次先后，这个人的版本号加一（db/schema-project-order-revisions.ts）。页面保存时带上开写前刚读到的
// 版本号（base），对不上就不写、回 stale：保存超时后被掐掉的旧请求晚到时，它的 base 早已过时。
// 不带 base 的写入（设置接口、脚本、老页面）照写不误，但同样让版本号加一 —— 在它之前读的版本号随之作废。
type OrderTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function revisionOf(tx: Pick<typeof db, "select">, owner: string): Promise<number> {
  const row = (await tx.select({ rev: projectOrderRevisions.rev }).from(projectOrderRevisions)
    .where(eq(projectOrderRevisions.owner, owner))).at(0);
  return row?.rev ?? 0;
}

async function bumpRevision(tx: OrderTx, owner: string): Promise<number> {
  const [row] = await tx.insert(projectOrderRevisions).values({ owner, rev: 1 })
    .onConflictDoUpdate({ target: projectOrderRevisions.owner, set: { rev: sql`${projectOrderRevisions.rev} + 1` } })
    .returning({ rev: projectOrderRevisions.rev });
  return row.rev;
}

/**
 * 整份顺序一次写下，并让版本号加一（同一个事务）。`base` 给了就是比对写：版本号已经不是它，就不写、回 stale。
 * 只留这个人看得见、还存在的项目 id（删掉的、看不见的写进去也只是占地方），去重。
 */
export async function saveProjectOrder(actor: Actor, projectIds: unknown[], base: number | null) {
  const visible = await visibleProjectIds(actor);
  const known = new Set((await db.select({ id: projects.id }).from(projects)).map((row) => row.id));
  const projectOrder = [...new Set(projectIds.filter((value): value is string =>
    typeof value === "string" && known.has(value) && (visible === null || visible.has(value))))];
  const patch = parseAppSettingsPatch({ projectOrder });
  const owner = ownerIdOf(actor) ?? "";
  const result = await db.transaction(async (tx) => {
    const current = await revisionOf(tx, owner);
    if (base !== null && base !== current) return { rev: current, stale: true as const };
    await writePersonalSettings(actor, patch, tx);
    return { rev: await bumpRevision(tx, owner) };
  });
  if (!("stale" in result)) bus.publish({ type: "projects.reordered", ownerUserId: ownerIdOf(actor) });
  return { projectOrder, ...result };
}

export function mountProjectOrderRoutes(api: Hono): void {
  // 页面开写前读一次版本号（连同此刻的顺序）。
  api.get("/project-order", async (c) => {
    const actor = actorOf(c);
    const { projectOrder } = await settingsForActor(actor);
    return c.json({ projectOrder, rev: await revisionOf(db, ownerIdOf(actor) ?? "") });
  });

  // 整份顺序一次写下（拖完一次就是一份新顺序，不做「把 A 挪到 B 前面」的增量：增量要靠服务端
  // 那份旧顺序拼，两个页面各拖一下就拼出谁都没排过的结果）。
  api.put("/project-order", async (c) => {
    try {
      const body = await c.req.json<{ projectIds?: unknown; base?: unknown }>();
      if (!Array.isArray(body.projectIds)) return c.json({ error: "projectIds 必须是数组" }, 400);
      if (body.base !== undefined && !(typeof body.base === "number" && Number.isSafeInteger(body.base) && body.base >= 0)) {
        return c.json({ error: "base 必须是非负整数" }, 400);
      }
      return c.json(await saveProjectOrder(actorOf(c), body.projectIds, body.base ?? null));
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
