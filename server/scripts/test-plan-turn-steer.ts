// 计划模式回合能被「引导会话」：它在库里也记 native_turn、运行时身份是旁路，但那只是为了不按
// 任务执行结算，原话照样能原生插进同一条会话（runs.ts `planSteerTarget`）。真正的 CLI 原生命令
// 回合（`/compact`）仍然不让引导；计划回合里要换执行器/模型的消息也不让（那只能硬切重起）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-plan-turn-steer-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");

const [{ db, ensureSchema }, schema, runs, steer, gate, pendingWait] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/task-steer-gate.js"),
  import("../src/pending-wait.js"),
]);
const { projects, scheduledMessages, tasks } = schema;
await ensureSchema();

const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "plan-steer", repoPath: root, apiKeys: null, createdAt: at });
const task = (id: string): typeof tasks.$inferInsert => ({
  id, projectId: "p", title: id, body: "test", mode: "single", status: "running",
  // 计划回合与 `/compact` 在库里长得一样：都记 native_turn。
  nativeTurn: true, activeTurnToken: `${id}-turn`, activeDirectionToken: `${id}-direction`,
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: at, updatedAt: at,
});
const message = (id: string, taskId: string, extra: Partial<typeof scheduledMessages.$inferInsert> = {}): typeof scheduledMessages.$inferInsert => ({
  id, taskId, text: `${id} 的原话`, attachments: "[]", mode: "queued", sendAt: at, status: "pending",
  createdAt: at, sentAt: null, deliveringSince: null, ...extra,
});
const row = async (id: string) => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id))).at(0)!;
const taskRow = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const refusal = async (messageId: string, taskId: string) => gate.steerRefusal(await row(messageId), await taskRow(taskId), messageId);
const steerableOnTray = async (taskId: string, messageId: string) =>
  (await pendingWait.pendingMessagePresence(taskId, [{ ...await row(messageId), afterDone: false, afterEndedAt: null, afterWaitReason: null }])).at(0)!.steerable;

await db.insert(tasks).values([task("plan"), task("compact"), task("plan-model")]);
await db.insert(scheduledMessages).values([
  message("m-plan", "plan"),
  message("m-compact", "compact"),
  message("m-plan-model", "plan-model", { model: "claude-sonnet-5" }),
]);

/** 起一轮占着锁、身份是旁路的回合，挂一个会原生收话的句柄。 */
function liveSideTurn(taskId: string, plan: boolean) {
  const owner = runs.claimOwnTurn(taskId);
  assert.ok(owner, `${taskId} 应能占到回合`);
  runs.reclaimTurn(taskId, owner, plan ? "side" : "native");
  const sent: string[] = [];
  const recorded: string[] = [];
  let kills = 0;
  const handle = {
    kill: () => { kills += 1; },
    steer: async (text: string | (() => string | Promise<string>), beforeSend?: () => void | Promise<void>) => {
      await beforeSend?.();
      sent.push(typeof text === "function" ? await text() : text);
    },
  };
  runs.trackRun(taskId, handle);
  runs.bindNativeSteer(taskId, handle, { agentType: "claude", record: (text) => { recorded.push(text); }, plan });
  return {
    sent, recorded, kills: () => kills,
    end() { runs.untrackRun(taskId, handle); runs.releaseTurn(taskId, owner); },
  };
}

try {
  // 没有句柄时谁都认不出是计划回合，按原生命令回合拒（重启接回那一轮也是这一档）。
  assert.match((await refusal("m-plan", "plan"))?.error ?? "", /CLI 命令/);

  const plan = liveSideTurn("plan", true);
  assert.deepEqual(runs.planSteerTarget("plan"), { agentType: "claude" });
  assert.equal(await refusal("m-plan", "plan"), null, "计划回合里用户最早那条排队消息应能引导");
  assert.equal(await steerableOnTray("plan", "m-plan"), true, "托盘上要给出「引导会话」");
  const result = await steer.steerQueuedMessage("m-plan");
  assert.deepEqual(result, { ok: true, taskId: "plan", messageId: "m-plan" });
  assert.equal(plan.kills(), 0, "计划回合只走原生引导，不杀进程");
  assert.equal(plan.sent.length, 1);
  assert.match(plan.sent[0]!, /m-plan 的原话/, "原话原样送进同一条会话");
  assert.match(plan.recorded[0]!, /m-plan 的原话/, "会话里记下这条真人原话");
  assert.equal((await row("m-plan")).status, "sent");
  plan.end();
  assert.equal(runs.planSteerTarget("plan"), null, "句柄注销后计划回合的标记跟着消失");
  console.log("✓ 计划模式回合可以原生引导，不杀进程");

  const compact = liveSideTurn("compact", false);
  assert.equal(runs.planSteerTarget("compact"), null);
  assert.match((await refusal("m-compact", "compact"))?.error ?? "", /CLI 命令/, "原生命令回合仍不让引导");
  assert.equal(await steerableOnTray("compact", "m-compact"), false);
  compact.end();
  console.log("✓ CLI 原生命令回合仍然不让引导");

  const planModel = liveSideTurn("plan-model", true);
  assert.match((await refusal("m-plan-model", "plan-model"))?.error ?? "", /计划模式/,
    "计划回合里要换模型的消息只能等这一轮结束");
  assert.equal(await steerableOnTray("plan-model", "m-plan-model"), false);
  const refused = await steer.steerQueuedMessage("m-plan-model");
  assert.equal(refused.ok, false);
  assert.equal(planModel.kills(), 0, "拒绝时不得退回硬切");
  assert.equal((await row("m-plan-model")).status, "pending");
  planModel.end();
  console.log("✓ 计划回合里原生送不进去的消息继续排队，不退回硬切");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
