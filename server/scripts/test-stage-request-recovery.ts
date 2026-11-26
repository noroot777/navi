// 上报阶段执行到一半被停掉、带同一个请求号重试（server/src/request-receipts.ts，第 2 轮审查 F1）：普通阶段
// （task-stage.ts `reportTaskStage`）与自由审查结论（free-workflow.ts `reportFreeReviewConclusion`）两条提交路径
// 都把答复跟那一笔写在同一个事务里。
//   · 业务提交了、答复没记下 → 回放提交时写下的答复，不再进端点（再进会被当成第二次上报拒掉）
//   · 开始记账了、还没进业务 → 重进端点，照常提交一次
// 停掉那一下用「库里留下的样子」模拟：记答复的那一笔写不进去（真停机时它根本没执行）、或者里层压根没走到业务。
// 真强杀的端到端在 test-mcp-restart-delivery.ts（普通阶段）。
import assert from "node:assert/strict";
import { Hono } from "hono";
import { dbClient, teardown } from "./monitors-fixture.js";
import { setupRegressionReviews } from "./regression-review-fixture.js";

const { requestReceipts } = await import("../src/request-receipts.js");
const { mountTaskStageRoutes } = await import("../src/task-stage.js");

try {
  const { open } = await setupRegressionReviews();
  // 停在业务前：里层不走到路由就答，答复那一笔也写不进去
  let abortBeforeBusiness = false;
  let receiptWriteFails = false;
  const entered = new Map<string, number>();
  const app = new Hono();
  app.use("/api/*", requestReceipts());
  app.use("/api/tasks/:id/stage", async (c, next) => {
    if (abortBeforeBusiness) return c.json({ aborted: true });
    entered.set(c.req.param("id"), (entered.get(c.req.param("id")) ?? 0) + 1);
    return next();
  });
  const api = new Hono();
  mountTaskStageRoutes(api);
  app.route("/api", api);
  const execute = dbClient.execute.bind(dbClient);
  dbClient.execute = (async (statement: Parameters<typeof execute>[0]) => {
    if (receiptWriteFails && typeof statement !== "string" && statement.sql.startsWith("UPDATE request_receipts SET status")) {
      throw new Error("服务在这一下停掉了");
    }
    return execute(statement);
  }) as typeof dbClient.execute;
  const consoleWarn = console.warn;
  console.warn = () => {};

  for (const mode of ["free", "preset"] as const) {
    const review = await open(mode);
    const stage = (requestId: string) => app.request(`/api/tasks/${review.taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-navi-turn-token": `turn-${review.ownerTaskId}`,
        "x-navi-source-task-id": review.ownerTaskId, "x-navi-request-id": requestId },
      body: JSON.stringify({ stage: "verified" }) });
    const receipt = async (requestId: string) => (await execute({
      sql: "SELECT status, effect FROM request_receipts WHERE request_id = ?", args: [requestId] })).rows[0];

    // 业务提交了、答复没记下
    receiptWriteFails = true;
    const first = await stage(`stage-after-${mode}`);
    receiptWriteFails = false;
    assert.equal(first.status, 200, `${mode}: ${await first.clone().text()}`);
    const firstBody = await first.json() as { reported: boolean; freeReview?: { runId: string; round: number } };
    assert.equal(await review.conclusion(), "verified", `${mode}: 结论提交了`);
    const orphan = await receipt(`stage-after-${mode}`);
    assert.equal(orphan?.status, null, `${mode}: 答复没记下（停在这一下）`);
    assert.ok(orphan?.effect, `${mode}: 提交那一笔在同一个事务里写下了答复`);
    const retry = await stage(`stage-after-${mode}`);
    assert.equal(retry.status, 200, `${mode}: 重试拿回原来的答复，不是「不确定」：${await retry.clone().text()}`);
    assert.equal(retry.headers.get("x-navi-request-replayed"), "1");
    const retryBody = await retry.json() as typeof firstBody;
    assert.equal(retryBody.reported, true);
    if (mode === "free") assert.deepEqual(retryBody.freeReview, firstBody.freeReview, "自由审查：交回同一条链、同一轮");
    assert.equal(entered.get(review.taskId), 1, `${mode}: 回放，不再进端点`);
    assert.equal((await receipt(`stage-after-${mode}`))?.status, 200, `${mode}: 回放时把答复补记上`);

    // 开始记账了、还没进业务：换一轮干净的上报
    const fresh = await open(mode);
    const freshStage = (requestId: string) => app.request(`/api/tasks/${fresh.taskId}/stage`, { method: "POST",
      headers: { "content-type": "application/json", "x-navi-turn-token": `turn-${fresh.ownerTaskId}`,
        "x-navi-source-task-id": fresh.ownerTaskId, "x-navi-request-id": requestId },
      body: JSON.stringify({ stage: "verified" }) });
    abortBeforeBusiness = true;
    receiptWriteFails = true;
    await freshStage(`stage-before-${mode}`);
    abortBeforeBusiness = false;
    receiptWriteFails = false;
    const before = await receipt(`stage-before-${mode}`);
    assert.ok(before && before.status === null && before.effect === null, `${mode}: 只留下「开始了」那一行`);
    assert.notEqual(await fresh.conclusion(), "verified");
    const late = await freshStage(`stage-before-${mode}`);
    assert.equal(late.status, 200, `${mode}: 没进业务的照常执行：${await late.clone().text()}`);
    assert.equal(await fresh.conclusion(), "verified");
    assert.equal(entered.get(fresh.taskId), 1, `${mode}: 执行了一次`);
    console.log(`✓ ${mode}: 上报阶段提交了、答复没记下 → 回放同一份答复；没进业务 → 重进照常提交一次`);
  }
  console.warn = consoleWarn;
} finally { await teardown(); }
