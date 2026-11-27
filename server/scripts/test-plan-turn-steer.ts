// 计划模式回合能被「引导会话」：它在库里也记 native_turn、运行时身份是旁路，但那只是为了不按
// 任务执行结算，原话照样能原生插进同一条会话（runs.ts `planSteerTarget`）。真正的 CLI 原生命令
// 回合（`/compact`）仍然不让引导；计划回合里要换执行器/模型的消息也不让（那只能硬切重起）。
// 连带三件：能不能引导一变就让托盘重拉；引导之后计划回合里的提问照常挂上（不按方向分新旧）；
// 重启接回的计划回合照样认得出来；引导没送进去时，原会话期间新问的那一问留着，身份照样回来；
// 回滚跟回合结算撞在一起时，结算看不到「身份回来了、内容还没回来」的半成品。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@navi/shared";
import type { ResidentHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-plan-turn-steer-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");

const [{ db, ensureSchema }, schema, runs, steer, gate, pendingWait, { bus }, { consumeSingleRun }, { singleRunFromResident }, { ClaudeExecutor }, directionState, { settleTaskStatus }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/task-steer-gate.js"),
  import("../src/pending-wait.js"),
  import("../src/bus.js"),
  import("../src/single-run.js"),
  import("../src/executors/claude-single-run.js"),
  import("../src/executors/claude.js"),
  import("../src/task-steer-direction-state.js"),
  import("../src/settle-status.js"),
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

await db.insert(tasks).values([task("plan"), task("compact"), task("plan-model"), task("plan-ask"), task("plan-fail")]);
await db.insert(scheduledMessages).values([
  message("m-plan", "plan"),
  message("m-compact", "compact"),
  message("m-plan-model", "plan-model", { model: "claude-sonnet-5" }),
  message("m-plan-ask", "plan-ask"),
  message("m-plan-fail", "plan-fail"),
]);
const trayReloads: string[] = [];
bus.subscribe((event) => { if (event.type === "task.pendingMessages") trayReloads.push(event.taskId); });
const reloadsOf = (taskId: string) => trayReloads.filter((id) => id === taskId).length;
const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
};

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
  assert.equal(reloadsOf("plan"), 1, "绑上计划回合的引导目标就让托盘重拉，绑定前读到的「不能引导」不能一直挂着");
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
  const reloadsBeforeEnd = reloadsOf("plan");
  plan.end();
  assert.equal(runs.planSteerTarget("plan"), null, "句柄注销后计划回合的标记跟着消失");
  assert.equal(reloadsOf("plan"), reloadsBeforeEnd + 1, "撤掉计划回合的引导目标也让托盘重拉");
  console.log("✓ 计划模式回合可以原生引导，不杀进程");

  const compact = liveSideTurn("compact", false);
  assert.equal(runs.planSteerTarget("compact"), null);
  assert.equal(reloadsOf("compact"), 0, "能不能引导没变就不打扰托盘");
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

  // 引导之后的提问：真的 claude 单飞适配器 + 真的消费循环。库里的方向身份已经换了，之后读到的
  // 提问照常挂上；打断前旧方向问到一半、迟到的那一问也不让这一轮报错（它可能被送达前那一扫清掉，
  // 也可能挂出来，两样都行）。
  {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const push = (event: AgentEvent) => { queue.push(event); wake?.(); wake = null; };
    const resident: ResidentHandle = {
      sessionId: "plan-ask-cli",
      commandLine: "claude -p --permission-mode plan --permission-prompt-tool stdio --input-format stream-json",
      events: (async function* () {
        while (true) {
          if (queue.length) { yield queue.shift()!; continue; }
          if (ended) return;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      })(),
      send: () => true,
      interrupt: () => {},
      // 打断写出去之后、ACK 回来之前，旧方向还在吐：它刚问的那一问和被打断出来的结尾都排在新消息前面。
      steer: async (_text, onInterrupted, beforeSend) => {
        onInterrupted?.();
        push({ kind: "userInput", questions: [{ question: "旧方向：要不要先做 A？", options: ["要", "不要"] }] });
        push({ kind: "turnEnd", interrupted: true });
        await beforeSend?.();
      },
      close: () => { ended = true; wake?.(); },
      kill: () => { ended = true; wake?.(); },
    };
    const handle = singleRunFromResident(resident);
    const owner = runs.claimOwnTurn("plan-ask");
    assert.ok(owner);
    runs.reclaimTurn("plan-ask", owner, "side");
    runs.trackRun("plan-ask", handle);
    const out = createWriteStream(join(root, "plan-ask.md"));
    const consuming = consumeSingleRun({
      taskId: "plan-ask", sessId: "plan-ask-session", agentType: "claude",
      ex: { model: null, reasoningEffort: null } as never, cwd: root, handle, out,
      turnStart: at, cliSessionId: "plan-ask-cli", autoTitle: false,
      nativeSteer: { record: () => {}, plan: true },
    }).then(() => null, (error: unknown) => error);
    await waitFor(() => !!runs.planSteerTarget("plan-ask"), "消费循环绑上计划回合的引导目标");

    push({ kind: "userInput", questions: [{ question: "起步：部署在哪？", options: ["本机", "云端"] }] });
    await waitFor(async () => (await taskRow("plan-ask")).question === "起步：部署在哪？", "引导前的提问照常挂上");

    assert.deepEqual(await steer.steerQueuedMessage("m-plan-ask"), { ok: true, taskId: "plan-ask", messageId: "m-plan-ask" });
    const newDirection = (await taskRow("plan-ask")).activeDirectionToken;
    assert.notEqual(newDirection, "plan-ask-direction", "引导换了方向");
    push({ kind: "userInput", questions: [{ question: "新方向：标准款按定稿判断？", options: ["是", "否"] }] });
    await waitFor(async () => (await taskRow("plan-ask")).question === "新方向：标准款按定稿判断？", "引导后新方向的提问挂上");
    assert.equal((await taskRow("plan-ask")).activeDirectionToken, newDirection);

    push({ kind: "turnEnd" });
    assert.equal(await consuming, null, "引导之后的提问不得让这一轮报错");
    runs.untrackRun("plan-ask", handle);
    runs.releaseTurn("plan-ask", owner);
    await new Promise<void>((resolve) => out.end(resolve));
    console.log("✓ 引导之后读到的提问照常挂上，这一轮不报错");
  }


  // 引导在写出打断之前失败：原进程还活着、只认得旧方向身份。清场到回滚之间它问的那一问按回合
  // 存下了 —— 回滚不能因为提问那格被占就连身份一起放弃，否则它之后交卷/暂停/再提问都被当成
  // 过期方向拒掉（第 3 轮自由审查）。
  {
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const push = (event: AgentEvent) => { queue.push(event); wake?.(); wake = null; };
    const resident: ResidentHandle = {
      sessionId: "plan-fail-cli",
      commandLine: "claude -p --permission-mode plan --permission-prompt-tool stdio --input-format stream-json",
      events: (async function* () {
        while (true) {
          if (queue.length) { yield queue.shift()!; continue; }
          if (ended) return;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      })(),
      send: () => true,
      interrupt: () => {},
      steer: async () => {
        push({ kind: "userInput", questions: [{ question: "引导没送进去时原会话新问的", options: ["甲", "乙"] }] });
        await waitFor(async () => (await taskRow("plan-fail")).question === "引导没送进去时原会话新问的", "期间的提问按回合存下");
        throw new Error("模拟 interrupt 写出前失败");
      },
      close: () => { ended = true; wake?.(); },
      kill: () => { ended = true; wake?.(); },
    };
    const handle = singleRunFromResident(resident);
    const owner = runs.claimOwnTurn("plan-fail");
    assert.ok(owner);
    runs.reclaimTurn("plan-fail", owner, "side");
    runs.trackRun("plan-fail", handle);
    const out = createWriteStream(join(root, "plan-fail.md"));
    const consuming = consumeSingleRun({
      taskId: "plan-fail", sessId: "plan-fail-session", agentType: "claude",
      ex: { model: null, reasoningEffort: null } as never, cwd: root, handle, out,
      turnStart: at, cliSessionId: "plan-fail-cli", autoTitle: false,
      nativeSteer: { record: () => {}, plan: true },
    }).then(() => null, (error: unknown) => error);
    await waitFor(() => !!runs.planSteerTarget("plan-fail"), "消费循环绑上计划回合的引导目标");

    const failed = await steer.steerQueuedMessage("m-plan-fail");
    assert.equal(failed.ok, false);
    const after = await taskRow("plan-fail");
    assert.equal(after.activeDirectionToken, "plan-fail-direction", "原会话的方向身份回来了");
    assert.equal(after.activeTurnToken, "plan-fail-turn");
    assert.equal(after.question, "引导没送进去时原会话新问的", "期间新问的那一问留着");
    assert.equal((await row("m-plan-fail")).status, "pending", "消息继续排队");
    // 用例到此为止：别让回合一放开就把它投递出去（那时库已经关了）。
    await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, "m-plan-fail"));

    push({ kind: "turnEnd" });
    assert.equal(await consuming, null);
    runs.untrackRun("plan-fail", handle);
    runs.releaseTurn("plan-fail", owner);
    await new Promise<void>((resolve) => out.end(resolve));
    console.log("✓ 引导没送进去时，原会话期间的提问留着，身份照样回来");
  }

  // 回滚落库之后、回滚函数拿到结果之前，原会话正好自然结束、进了真结算（生产上这中间隔着一次
  // 真实的 await）。结算要么看到全没回来、要么全回来了：等答复的那一问、已经交的卷都不许被判成
  // 未交卷（第 4 轮自由审查：身份和内容分两笔落时，结算读到的是半成品）。
  for (const mode of ["question", "complete"] as const) {
    const id = `race-${mode}`;
    await db.insert(tasks).values({
      ...task(id), nativeTurn: false,
      ...(mode === "question" ? { question: "原会话还在等用户回答的问题" } : { completeConfirmedAt: at }),
    });
    const previous = await directionState.clearPreviousDirectionState(id, false);
    const realUpdate = db.update.bind(db);
    let settled: Awaited<ReturnType<typeof settleTaskStatus>> | null = null;
    (db as { update: unknown }).update = (table: unknown) => {
      const builder = realUpdate(table as typeof tasks);
      const set = builder.set.bind(builder);
      (builder as { set: unknown }).set = (patch: Record<string, unknown>) => {
        const query = set(patch as never);
        if (table !== tasks || patch.activeDirectionToken !== `${id}-direction`) return query;
        const returning = query.returning.bind(query);
        (query as { returning: unknown }).returning = (...args: unknown[]) => {
          const result = returning(...(args as []));
          return {
            then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) =>
              Promise.resolve(result).then(async (rows: unknown[]) => {
                if (rows.length && !settled) settled = await settleTaskStatus(id, 0, null);
                return rows;
              }).then(resolve, reject),
          };
        };
        return query;
      };
      return builder;
    };
    try {
      await directionState.restorePreviousDirectionState(id, previous);
    } finally {
      (db as { update: unknown }).update = realUpdate;
    }
    assert.ok(settled, "台子前提：结算确实插在了回滚落库之后");
    const outcome = settled as Awaited<ReturnType<typeof settleTaskStatus>>;
    assert.notEqual(outcome.status, "failed", `${mode}：结算不许把它判成未交卷`);
    if (mode === "question") assert.equal((await taskRow(id)).question, "原会话还在等用户回答的问题", "那一问还在等答复");
    else assert.equal(outcome.confirmedDone, true, "已经交的卷照样作数");
  }
  console.log("✓ 回滚跟回合结算撞在一起：等答复的那一问、已经交的卷都不会被判成未交卷");

  // 重启接回：执行器从起跑命令认回计划回合。
  {
    const executor = new ClaudeExecutor();
    const adopt = (commandLine: string) => {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
      const handle = executor.attach(child, { sessionId: "reattach", commandLine });
      child.kill();
      return handle.planTurn;
    };
    assert.equal(adopt("claude -p --permission-mode plan --permission-prompt-tool stdio --input-format stream-json"), true,
      "接回的计划回合要认得出来");
    assert.equal(adopt("claude -p --dangerously-skip-permissions --input-format stream-json"), false);
    console.log("✓ 重启接回的计划回合照样认得出来");
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
