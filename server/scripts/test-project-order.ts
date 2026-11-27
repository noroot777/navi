// 项目先后（个人设置 projectOrder，server/src/project-order.ts）的后端回归：
//  · GET /projects 按排过的先后下发，没排过的接在后面、保持创建先后；
//  · PUT /project-order 只留存在的项目 id，去重；坏请求体 400；
//  · 写完推一条只给本人的 projects.reordered；
//  · 每写一次版本号加一；带 base 的写对不上就回 stale、不改顺序、不推信号：超时后被掐掉的旧请求晚到盖不回去；
//  · 版本号在库里（服务重启后晚到的旧请求照样作废）；不带 base 的写入（设置接口走的那条）也让它加一。
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

const [{ ensureSchema }, projectRoutes, order, { bus }, context] = await Promise.all([
  import("../src/db/index.js"),
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

// ── 版本号：对得上才写 ───────────────────────────────────────────────────────
const revision = async () => (await call("/project-order")).body as { projectOrder: string[]; rev: number };
const put = (names: string[], base?: number) =>
  call("/project-order", "PUT", { projectIds: names.map((name) => ids[name]), base });
const reordered = () => events.filter((event) => event.type === "projects.reordered").length;
{
  const before = await revision();
  assert.equal(before.rev, 1, "上面那次不带 base 的写也算一次");
  assert.deepEqual(before.projectOrder, [ids.gamma, ids.alpha]);
  const saved = await put(["beta", "alpha", "gamma", "delta"], before.rev);
  assert.equal(saved.body.stale, undefined);
  assert.equal(saved.body.rev, 2, "写上一次加一");
  assert.deepEqual(await listed(), ["beta", "alpha", "gamma", "delta"]);

  // 掐掉的旧请求（base 1）在新的一份写上之后才到：对不上，不写、不推信号。
  const signals = reordered();
  const late = await put(["alpha", "beta", "gamma", "delta"], before.rev);
  assert.equal(late.body.stale, true, "版本号过时的是旧请求");
  assert.equal(late.body.rev, 2, "stale 时带回此刻的版本号");
  assert.deepEqual(await listed(), ["beta", "alpha", "gamma", "delta"], "晚到的旧请求盖不回去");
  assert.equal(reordered(), signals, "没写就不推信号");
  assert.equal((await put(["delta", "beta", "alpha", "gamma"], 5)).body.stale, true, "超前的版本号也对不上");

  // 不带 base 的写入照写，版本号照加：在它之前读到的版本号随之作废。
  assert.equal((await order.saveProjectOrder(context.SINGLE_ACTOR, [ids.gamma, ids.alpha, ids.beta, ids.delta], null)).rev, 3);
  assert.equal(reordered(), signals + 1);
  assert.equal((await put(["alpha", "beta", "gamma", "delta"], 2)).body.stale, true, "设置接口写过之后，之前读的版本号作废");
  assert.deepEqual(await listed(), ["gamma", "alpha", "beta", "delta"]);
}

// ── 重启之后晚到的旧请求照样作废 ─────────────────────────────────────────────
{
  // 版本号在库里，路由本身不持状态：换一个全新挂载的路由（相当于服务重启后的新进程）照样认得出旧请求。
  const restarted = new Hono();
  restarted.use("*", async (c, next) => { context.setActor(c, context.SINGLE_ACTOR); await next(); });
  order.mountProjectOrderRoutes(restarted);
  const send = async (base: number) => (await (await restarted.request("http://x/project-order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectIds: ["alpha", "beta", "gamma", "delta"].map((name) => ids[name]), base }),
  })).json()) as { stale?: true; rev: number };
  assert.equal((await send(2)).stale, true, "重启前就过时的版本号，重启后晚到也不算数");
  assert.deepEqual(await listed(), ["gamma", "alpha", "beta", "delta"]);
  assert.equal((await send(3)).rev, 4, "版本号对得上照常写");
  assert.deepEqual(await listed(), ["alpha", "beta", "gamma", "delta"]);
}

// ── 坏请求体 ─────────────────────────────────────────────────────────────────
{
  assert.equal((await call("/project-order", "PUT", { projectIds: "alpha" })).status, 400);
  assert.equal((await call("/project-order", "PUT", {})).status, 400);
  assert.equal((await call("/project-order", "PUT", { projectIds: [], base: "4" })).status, 400);
  assert.equal((await call("/project-order", "PUT", { projectIds: [], base: -1 })).status, 400);
  assert.deepEqual(await listed(), ["alpha", "beta", "gamma", "delta"], "坏请求不改顺序");
}

await releaseTmpDb();
rmSync(root, { recursive: true, force: true });
console.log("✓ project order");
