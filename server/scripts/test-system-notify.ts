// 系统通知（server/src/system-notify.ts + system-notify-facts.ts）：什么时候往客户端推一条 task.notify。
//
// 钉住的几件事：
// ① 记底：头一回启用时已有的待验收、失败都只记底，不补推；记底时还在跑的之后跑完照推；记底时正在续聊的已完成任务，
//    续聊挂了放回原 done，不说「完成了」；记底之后、头一次全量对账之前收拾出来的中断（启动恢复），全量对账照推，
//    也不提前推；已验收任务的续聊在重启时挂了，全量对账也找得到它；
// ② 新任务：跑完等验收推一条，重复对账不再推；
// ③ 停下来提问推一条，带上问题；跑挂了（中断）推一条；验收落章推一条，「等你验收」那件事没了不另推；
// ④ 验证没过、验收前置命令没过各推一条；门禁通过不单推；同一版重新验证又没过再推，同一版的「等你验收」只说一次；
// ⑤ 回合锁还占着（这一轮还在结算）先不推，锁放开自己再对一次；
// ⑥ 归档的任务不推；一次对账同一个人超过上限合成一条；
// ⑦ 自用模式下 SSE 照推（合成的那一条也推）；
// ⑧ 续聊挂了、原来的 done 放回去（真结算）：不说「完成了」，说「这一轮中断了」；续聊真完成了才是新的一次完成；
// ⑨ 被停下（canceled）推一条，不重复；
// ⑩ 完成之后再派审：审查没通过推「审查没通过」；审着的时候完成的那一版，审查通过才推「审查通过，等你验收」。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@navi/shared";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "navi-system-notify-"));
process.env.NAVI_DB = join(stage, "ash.db");
process.env.NAVI_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-system-notify");

type Notice = Extract<ServerEvent, { type: "task.notify" }>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failure: unknown = null;
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, sessions, sessionTurns } = await import("../src/db/schema.js");
  const { acceptGateRuns } = await import("../src/db/schema-accept-gate.js");
  const { freeReviewRuns } = await import("../src/db/schema-free-workflow.js");
  const { claimOwnTurn, releaseTurn } = await import("../src/turn-lock.js");
  const { SystemNotifier, DIGEST_OVER } = await import("../src/system-notify.js");
  const { makeEventFilter } = await import("../src/auth/event-filter.js");
  const { SINGLE_USER_ID } = await import("../src/auth/context.js");
  const { settleTaskStatus } = await import("../src/settle-status.js");
  const { eq } = await import("drizzle-orm");

  await ensureSchema();
  mkdirSync(join(stage, "repo"), { recursive: true });
  const old = "2020-01-01T00:00:00.000Z";
  const at = () => new Date().toISOString();
  await db.insert(projects).values({ id: "p1", name: "通知项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: old } as never);
  const task = (over: Record<string, unknown>) => ({ projectId: "p1", body: "", createdAt: at(), updatedAt: at(), ...over });
  const set = (id: string, change: Record<string, unknown>) => db.update(tasks).set({ updatedAt: at(), ...change } as never).where(eq(tasks.id, id));
  let turnNo = 0;
  const sessionOf = async (taskId: string) => {
    await db.insert(sessions).values({ id: `s-${taskId}`, taskId, role: "single", agentType: "claude", executor: "claude", startedAt: at() } as never)
      .onConflictDoNothing();
  };
  /** 这个任务的单飞会话上收口一个回合。 */
  const turnOf = async (taskId: string, outcome: string) => {
    await sessionOf(taskId);
    const stamp = new Date(Date.now() + ++turnNo).toISOString();
    await db.insert(sessionTurns).values({ id: `turn-${turnNo}`, sessionId: `s-${taskId}`, taskId, startedAt: stamp, endedAt: stamp, outcome } as never);
  };

  const seen: Notice[] = [];
  const notifier = new SystemNotifier((notice) => seen.push(notice));
  const take = () => seen.splice(0);
  const reconcile = async (...ids: string[]) => {
    await notifier.run(() => notifier.reconcile(ids));
    return take();
  };
  const kinds = (notices: Notice[]) => notices.map((notice) => [notice.taskId, notice.kind]);

  // ── ① 记底 ─────────────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "old-done", title: "早就干完了", status: "done", doneSeq: 1, endedAt: old, createdAt: old }) as never);
  await db.insert(tasks).values(task({ id: "old-failed", title: "早就挂了", status: "failed", endedAt: old, createdAt: old }) as never);
  await db.insert(tasks).values(task({ id: "old-running", title: "升级时在跑", status: "running", createdAt: old }) as never);
  await db.insert(tasks).values(task({ id: "old-crashed", title: "上次没跑完", status: "running", createdAt: old }) as never);
  await db.insert(tasks).values(task({ id: "old-follow", title: "升级时在续聊", status: "running", followUpFrom: "done", doneSeq: 1, createdAt: old }) as never);
  await db.insert(tasks).values(task({
    id: "old-accepted", title: "验收过了", status: "done", doneSeq: 1, stage: "accepted", acceptanceId: "acc-0",
    acceptedMergeMethod: "fast_forward", acceptedMergeCommit: "def", endedAt: old, createdAt: old,
  }) as never);
  await notifier.baseline();
  assert.deepEqual(take(), [], "记底：已有的待验收、失败都不补推");
  await notifier.baseline();
  assert.deepEqual(take(), [], "记过底不再记");

  // 启动恢复（记底之后、订阅和全量对账之前）：没接回来的落失败；已验收任务的续聊挂了、放回原 done
  await set("old-crashed", { status: "failed", endedAt: at() });
  await turnOf("old-accepted", "failed");
  await set("old-accepted", { endedAt: at() });
  notifier.mark("old-crashed");
  await sleep(500);
  assert.deepEqual(take(), [], "头一次全量对账之前：动静只攒着");
  await notifier.full();
  assert.deepEqual(kinds(take()), [["old-crashed", "failed"], ["old-accepted", "interrupted"]],
    "启动收拾出来的中断照推；已验收任务的续聊挂了也找得到");

  await set("old-running", { status: "done", doneSeq: 1, endedAt: at() });
  assert.deepEqual(kinds(await reconcile("old-running")), [["old-running", "accept"]], "记底时在跑、之后跑完：推");

  await turnOf("old-follow", "failed");
  assert.equal((await settleTaskStatus("old-follow", 1, null)).status, "done");
  assert.deepEqual(kinds(await reconcile("old-follow")), [["old-follow", "interrupted"]], "记底时在续聊：挂了不说「完成了」");

  // ── ② 新任务：跑完推一条，不重复 ───────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t1", title: "加个通知", status: "running" }) as never);
  assert.deepEqual(await reconcile("t1"), [], "还在跑：不推");
  await set("t1", { status: "done", doneSeq: 1, endedAt: at() });
  const done = await reconcile("t1");
  assert.equal(done.length, 1);
  assert.equal(done[0]!.kind, "accept");
  assert.equal(done[0]!.title, "加个通知");
  assert.equal(done[0]!.subtitle, "通知项目");
  assert.equal(done[0]!.body, "完成了，等你验收");
  assert.equal(done[0]!.taskId, "t1");
  assert.equal(done[0]!.projectId, "p1");
  assert.deepEqual(await reconcile("t1"), [], "重复对账不再推");
  await db.insert(tasks).values(task({ id: "t1b", title: "一眨眼就干完了", status: "done", doneSeq: 1, endedAt: at() }) as never);
  assert.deepEqual(kinds(await reconcile("t1b")), [["t1b", "accept"]], "新任务头一眼就是跑完了：推");

  // ── ③ 提问、中断、验收落章 ─────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t2", title: "要拍板", status: "running" }) as never);
  await reconcile("t2");
  await set("t2", { status: "paused", question: "用 A 方案还是 B 方案？" });
  const asked = await reconcile("t2");
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.kind, "question");
  assert.match(asked[0]!.body, /A 方案还是 B 方案/);
  await set("t2", { status: "running", question: null });
  assert.deepEqual(await reconcile("t2"), [], "答复了接着跑：不推");
  await set("t2", { status: "failed", endedAt: at() });
  const failed = await reconcile("t2");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.kind, "failed");
  assert.equal(failed[0]!.body, "中断了，等你处理");

  await set("t1", { stage: "accepted", acceptanceId: "acc-1", acceptedMergeMethod: "fast_forward", acceptedMergeCommit: "abc" });
  const accepted = await reconcile("t1");
  assert.deepEqual(accepted.map((notice) => notice.kind), ["accepted"], "落章推一条，「等你验收」没了不另推");
  assert.equal(accepted[0]!.body, "已验收合并");
  assert.deepEqual(await reconcile("t1"), []);

  // ── ④ 验证没过、门禁没过 ───────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t3", title: "验证一下", status: "running" }) as never);
  await reconcile("t3");
  await set("t3", { status: "done", doneSeq: 1, verifyRounds: 1, stage: "verify_failed", endedAt: at() });
  assert.deepEqual((await reconcile("t3")).map((notice) => notice.kind), ["verify_failed"]);
  await set("t3", { stage: "verifying" });
  assert.deepEqual((await reconcile("t3")).map((notice) => notice.kind), ["accept"], "重新验证中等着验收：这一版头一回说「等你验收」");
  await set("t3", { stage: "verify_failed" });
  assert.deepEqual(await reconcile("t3"), [], "同一轮验证的结论不重复");
  await set("t3", { stage: "verifying" });
  assert.deepEqual(await reconcile("t3"), [], "这一版说过「等你验收」了");
  await set("t3", { stage: "verify_failed", verifyRounds: 2 });
  assert.deepEqual((await reconcile("t3")).map((notice) => notice.kind), ["verify_failed"], "同一版重新验证又没过：再推");
  const gateRun = (id: string, status: string) => ({
    id, taskId: "t3", projectId: "p1", command: "npm test", cwd: stage, status, logPath: join(stage, `${id}.log`), startedAt: at(),
  });
  await set("t3", { status: "running", stage: null });
  await reconcile("t3");
  await db.insert(acceptGateRuns).values(gateRun("g1", "passed") as never);
  assert.deepEqual(await reconcile("t3"), [], "门禁通过不单推");
  await sleep(5);
  await db.insert(acceptGateRuns).values(gateRun("g2", "failed") as never);
  const gate = await reconcile("t3");
  assert.deepEqual(gate.map((notice) => notice.kind), ["gate_failed"]);
  assert.equal(gate[0]!.body, "验收前置命令没通过");

  // ── ⑤ 回合锁还占着：锁放开再推 ─────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t4", title: "结算中", status: "running" }) as never);
  await reconcile("t4");
  const owner = claimOwnTurn("t4")!;
  await set("t4", { status: "done", doneSeq: 1, endedAt: at() });
  assert.deepEqual(await reconcile("t4"), [], "还在结算：先不推");
  releaseTurn("t4", owner);
  await sleep(500);
  await notifier.run(async () => {});
  const settled = take();
  assert.equal(settled.length, 1, "锁放开自己再对一次");
  assert.equal(settled[0]!.taskId, "t4");

  // ── ⑥ 归档不推；一口气来一堆合成一条 ───────────────────────────────────
  await db.insert(tasks).values(task({ id: "t5", title: "归档了", status: "running" }) as never);
  await reconcile("t5");
  await set("t5", { status: "done", doneSeq: 1, archived: true, endedAt: at() });
  assert.deepEqual(await reconcile("t5"), [], "归档的不推");

  const bulk = Array.from({ length: DIGEST_OVER + 1 }, (_, i) => `b${i}`);
  for (const id of bulk) await db.insert(tasks).values(task({ id, title: `批量 ${id}`, status: "running" }) as never);
  await reconcile(...bulk);
  for (const id of bulk) await set(id, { status: "done", doneSeq: 1, endedAt: at() });
  const digest = await reconcile(...bulk);
  assert.equal(digest.length, 1, "超过上限合成一条");
  assert.equal(digest[0]!.kind, "digest");
  assert.equal(digest[0]!.taskId, null);
  assert.equal(digest[0]!.title, `${bulk.length} 件事等你看`);
  assert.match(digest[0]!.body, /等 \d+ 个任务/);
  assert.deepEqual(await reconcile(...bulk), [], "合成之后也记了账");

  // ── ⑦ 自用模式：SSE 照推 ───────────────────────────────────────────────
  const filter = makeEventFilter({ kind: "single", userId: SINGLE_USER_ID, role: "admin", name: "me" } as never);
  await filter.refresh();
  assert.ok(filter.allow(done[0]!), "自用模式推给本机");
  assert.ok(filter.allow(digest[0]!), "合成的那一条也推");
  filter.stop();

  // ── ⑧ 续聊挂了：不报完成 ───────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t6", title: "续聊", status: "running" }) as never);
  await reconcile("t6");
  await set("t6", { status: "done", doneSeq: 1, endedAt: at() });
  assert.deepEqual((await reconcile("t6")).map((notice) => notice.kind), ["accept"]);
  await set("t6", { status: "running", followUpFrom: "done" });
  assert.deepEqual(await reconcile("t6"), [], "续聊在跑：不推");
  await turnOf("t6", "failed");
  assert.equal((await settleTaskStatus("t6", 1, null)).status, "done", "失败的续聊把原来的 done 放回去");
  const restored = await reconcile("t6");
  assert.deepEqual(restored.map((notice) => notice.kind), ["interrupted"], "不说「完成了，等你验收」");
  assert.equal(restored[0]!.body, "这一轮中断了，结果还是上一版");
  assert.deepEqual(await reconcile("t6"), [], "不重复");
  await set("t6", { status: "running", followUpFrom: "done" });
  await reconcile("t6");
  await turnOf("t6", "completed");
  assert.equal((await settleTaskStatus("t6", 0, null)).status, "done");
  assert.deepEqual((await reconcile("t6")).map((notice) => notice.kind), ["accept"], "续聊真完成了：新的一次完成");

  // ── ⑨ 被停下 ───────────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "t7", title: "停掉", status: "running" }) as never);
  await reconcile("t7");
  await set("t7", { status: "canceled", endedAt: at() });
  const stopped = await reconcile("t7");
  assert.deepEqual(stopped.map((notice) => notice.kind), ["canceled"]);
  assert.equal(stopped[0]!.body, "已停止");
  assert.deepEqual(await reconcile("t7"), [], "不重复");

  // ── ⑩ 后来派的审查 ─────────────────────────────────────────────────────
  const review = (id: string, taskId: string, status: string, finished: boolean) => ({
    id, taskId, reviewerName: "审查者", agentType: "codex", checkMode: "free", targetKind: "workspace", status,
    createdAt: at(), updatedAt: at(), finishedAt: finished ? at() : null,
  });
  await db.insert(tasks).values(task({ id: "t8", title: "后派审查", status: "running", workflowMode: "free", mode: "single" }) as never);
  await reconcile("t8");
  await set("t8", { status: "done", doneSeq: 1, endedAt: at() });
  assert.deepEqual((await reconcile("t8")).map((notice) => notice.kind), ["accept"]);
  await sleep(5);
  await db.insert(freeReviewRuns).values(review("r1", "t8", "reviewing", false) as never);
  assert.deepEqual(await reconcile("t8"), [], "审着：不推");
  await db.update(freeReviewRuns).set({ status: "failed", finishedAt: at(), updatedAt: at() }).where(eq(freeReviewRuns.id, "r1"));
  const reviewFailed = await reconcile("t8");
  assert.deepEqual(reviewFailed.map((notice) => notice.kind), ["accept"], "后派的审查没通过：推");
  assert.equal(reviewFailed[0]!.body, "审查没通过，等你决定");

  await sleep(5);
  await db.insert(freeReviewRuns).values(review("r2", "t8", "reviewing", false) as never);
  await set("t8", { status: "running", followUpFrom: "done" });
  await reconcile("t8");
  await set("t8", { status: "done", doneSeq: 2, followUpFrom: null, endedAt: at() });
  assert.deepEqual(await reconcile("t8"), [], "审着的时候又完成了一版：等审查出结论");
  await sleep(5);
  await db.update(freeReviewRuns).set({ status: "passed", finishedAt: at(), updatedAt: at() }).where(eq(freeReviewRuns.id, "r2"));
  const reviewPassed = await reconcile("t8");
  assert.deepEqual(reviewPassed.map((notice) => notice.kind), ["accept"]);
  assert.equal(reviewPassed[0]!.body, "审查通过，等你验收");
  assert.deepEqual(await reconcile("t8"), [], "不重复");

  notifier.stop();
  console.log("test-system-notify: ok");
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
