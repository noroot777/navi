// 项目先后（个人设置 projectOrder，server/src/project-order.ts）的后端回归：
//  · GET /projects 按排过的先后下发，没排过的接在后面、保持创建先后；
//  · PUT /project-order 只留存在的项目 id，去重；坏请求体 400；
//  · 写完推一条只给本人的 projects.reordered；
//  · 同一页面（page）的意图按 seq 只认更大的：超时后被取代的旧请求晚到，回 stale、不改顺序；别的页面不受影响；
//  · 这份记录在库里（服务重启后晚到的旧请求照样作废），每人只留最近的 200 页。
//
// 跑：npx tsx server/scripts/test-project-order.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServerEvent } from "@navi/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-project-order-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
requireTmpDb("project-order");

const [{ db, ensureSchema }, { projectOrderIntents }, projectRoutes, order, { bus }, context] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/project-routes.js"),
  import("../src/project-order.js"),
  import("../src/bus.js"),
  import("../src/auth/context.js"),
]);

await ensureSchema();

// ── 排序函数本身 ─────────────────────────────────────────────────────────────
{
  const rows = ["a", "b", "c", "d"].map((id) => ({ id }));
  const ids = (list: { id: string }[]) => list.map((row) => row.id);
  assert.deepEqual(ids(order.orderProjects(rows, [])), ["a", "b", "c", "d"], "没排过就是原样");
  assert.deepEqual(ids(order.orderProjects(rows, ["c", "a"])), ["c", "a", "b", "d"], "排过的在前，没排过的接在后面、保持原来的先后");
  assert.deepEqual(ids(order.orderProjects(rows, ["gone", "d"])), ["d", "a", "b", "c"], "已经不在的 id 不占位");
}

const api = new Hono();
api.use("*", async (c, next) => { context.setActor(c, context.SINGLE_ACTOR); await next(); });
projectRoutes.mountProjectRoutes(api);
order.mountProjectOrderRoutes(api);

const events: ServerEvent[] = [];
bus.subscribe((event) => { events.push(event); });

const call = async (path: string, method = "GET", body?: unknown) => {
  const response = await api.request(`http://x${path}`, body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const listed = async () => ((await call("/projects")).body as { name: string }[]).map((project) => project.name);

const ids: Record<string, string> = {};
for (const name of ["alpha", "beta", "gamma"]) {
  const created = await call("/projects", "POST", { name, repoPath: join(root, name) });
  assert.equal(created.status, 201);
  ids[name] = created.body.id;
}
assert.deepEqual(await listed(), ["alpha", "beta", "gamma"], "出厂按创建先后");

// ── 写一份顺序 ───────────────────────────────────────────────────────────────
{
  const saved = await call("/project-order", "PUT", { projectIds: [ids.gamma, "nope", ids.alpha, ids.gamma] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.projectOrder, [ids.gamma, ids.alpha], "不存在的丢掉、重复的只留第一次");
  assert.deepEqual(await listed(), ["gamma", "alpha", "beta"], "没排进去的 beta 接在后面");
  assert.deepEqual(events.filter((event) => event.type === "projects.reordered"), [{ type: "projects.reordered", ownerUserId: null }]);
}

// ── 后建的项目接在最后 ───────────────────────────────────────────────────────
{
  assert.equal((await call("/projects", "POST", { name: "delta", repoPath: join(root, "delta") })).status, 201);
  assert.deepEqual(await listed(), ["gamma", "alpha", "beta", "delta"]);
}

// ── 同一页面晚到的旧意图作废 ─────────────────────────────────────────────────
{
  const put = (names: string[], page: string, seq: number) =>
    call("/project-order", "PUT", { projectIds: names.map((name) => ids[name]), page, seq });
  assert.equal((await put(["beta", "alpha", "gamma", "delta"], "page-a", 2)).status, 200);
  assert.deepEqual(await listed(), ["beta", "alpha", "gamma", "delta"]);
  const stale = await put(["alpha", "beta", "gamma", "delta"], "page-a", 1);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true, "序号更小的是被取代的旧意图");
  assert.deepEqual(await listed(), ["beta", "alpha", "gamma", "delta"], "晚到的旧意图盖不回去");
  assert.equal((await put(["delta", "beta", "alpha", "gamma"], "page-a", 2)).body.stale, true, "同一序号也不重放");
  assert.equal((await put(["gamma", "alpha", "beta", "delta"], "page-b", 1)).body.stale, undefined, "别的页面各记各的");
  assert.deepEqual(await listed(), ["gamma", "alpha", "beta", "delta"]);
  assert.equal((await put(["alpha", "beta", "gamma", "delta"], "page-a", 3)).body.stale, undefined);
  assert.deepEqual(await listed(), ["alpha", "beta", "gamma", "delta"]);
}

// ── 重启之后晚到的旧意图照样作废 ─────────────────────────────────────────────
{
  // 记录在库里，路由本身不持状态：换一个全新挂载的路由（相当于服务重启后的新进程）照样认得出旧序号。
  const rows = await db.select().from(projectOrderIntents);
  assert.deepEqual(rows.map((row) => [row.owner, row.page, row.seq]).sort(), [["", "page-a", 3], ["", "page-b", 1]]);
  const restarted = new Hono();
  restarted.use("*", async (c, next) => { context.setActor(c, context.SINGLE_ACTOR); await next(); });
  order.mountProjectOrderRoutes(restarted);
  const late = await restarted.request("http://x/project-order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectIds: ["gamma", "beta", "alpha", "delta"].map((name) => ids[name]), page: "page-a", seq: 2 }),
  });
  assert.equal((await late.json()).stale, true, "重启前已被取代的意图，重启后晚到也不算数");
  assert.deepEqual(await listed(), ["alpha", "beta", "gamma", "delta"]);
}

// ── 每人只留最近的 200 页 ───────────────────────────────────────────────────
{
  for (let index = 0; index < 205; index += 1) {
    await call("/project-order", "PUT", { projectIds: [ids.alpha], page: `bulk-${index}`, seq: 1 });
  }
  const pages = (await db.select({ page: projectOrderIntents.page }).from(projectOrderIntents)).map((row) => row.page);
  assert.equal(pages.length, 200);
  assert.ok(pages.includes("bulk-204") && !pages.includes("page-a"), "裁掉的是最早的那些页");
  await call("/project-order", "PUT", { projectIds: ["alpha", "beta", "gamma", "delta"].map((name) => ids[name]) });
}

// ── 坏请求体 ─────────────────────────────────────────────────────────────────
{
  assert.equal((await call("/project-order", "PUT", { projectIds: "alpha" })).status, 400);
  assert.equal((await call("/project-order", "PUT", {})).status, 400);
  assert.deepEqual(await listed(), ["alpha", "beta", "gamma", "delta"], "坏请求不改顺序");
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ project order");
