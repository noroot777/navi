// 系统通知（server/src/system-notify.ts + system-notify-facts.ts）：什么时候往客户端推一条 task.notify。
//
// 钉住的几件事：
// ① 记底：头一回启用时已有的待验收、失败都只记底，不补推；记底时还在跑的之后跑完照推；记底时正在续聊的已完成任务，
//    续聊挂了放回原 done，不说「完成了」；记底之后、头一次全量对账之前收拾出来的中断（启动恢复），全量对账照推，
//    也不提前推；已验收任务的续聊在重启时挂了，全量对账也找得到它；记底时有任务读不清（讨论记录打不开），别的任务照常
//    推，它读得清了只补记不补推；记底时正在续聊、早就审过的任务，续聊停下来不把老审查结论当新的推；
// ② 新任务：跑完等验收推一条，重复对账不再推；对账读现状的半路上任务刚好完成（视图读到在跑、身份读到已完成），
//    那次完成照推，不先记进账吞掉；读视图那一路顺手写库、开事务（等前置完成的消息、审查留下的消息）时，对账不等自己，
//    别处的写也不干等；
// ③ 停下来提问推一条，带上问题；跑挂了（中断）推一条；验收落章推一条，「等你验收」那件事没了不另推；
// ④ 验证没过、验收前置命令没过各推一条；门禁通过不单推；同一版重新验证又没过再推，同一版的「等你验收」只说一次；
// ⑤ 回合锁还占着（这一轮还在结算）先不推，锁放开自己再对一次；
// ⑥ 归档的任务不推；一次对账来一堆也一条一条推（合成在客户端，web/src/lib/noticeBatch.ts）；
// ⑦ 自用模式下 SSE 照推；
// ⑧ 续聊挂了、原来的 done 放回去（真结算）：不说「完成了」，说「这一轮中断了」；续聊真完成了才是新的一次完成；
// ⑨ 被停下推一条，不重复：落了 canceled 的、续聊被停放回原 done 的、失败任务上续聊被停的（不再说「中断了」）、
//    分组暂停的；停完重新排上、还没开新回合，不再说一遍；
// ⑩ 完成之后再派审：审查没通过推「审查没通过」；审着的时候完成的那一版，审查通过才推「审查通过，等你验收」；
//    不在等验收的任务（暂停着）上派的审：最后没过推「审查没通过」，过了推「审查通过」，各一条；自动修复复审的链：
//    转修复（收尾还没挂上续审、挂上之后）、续审在跑（finishedAt 还留着上一轮的）都不推，最后一轮没过才推，同一条链
//    再审一轮又没过再推；等验收的任务在转修复那一下也不推「审查没通过，等你决定」；
// ⑪ 团队调度台：回合挂了回到待命，不说「完成了」，说「这一轮中断了」；正常收口的回合才是新的一版；删掉、新加成员
//    不是新的一版，共享执行者真完成了才是，开独立工作区的那些完成了不算；
// ⑫ 多人模式：被移出项目的成员收不到那个项目里的通知（一条一条推，过滤器逐件核可见性）；有权限的成员，任务头一回
//    经过过滤器（归属缓存是冷的，比如重启后收拾出来的中断）也照推；
// ⑬ 重启：记过底不重记，记底之后的新事照推；账的记法变了按没记过底重记，老写法的账不当成新事；补记进度存不进去，
//    同一批别的任务记了账的照推；
// ⑭ 持续目标没交卷就停住、等人续跑：推一条，不重复；重新跑起来再停住又是一回；检查点暂停不推。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, sessions, sessionTurns } = await import("../src/db/schema.js");
  const { acceptGateRuns } = await import("../src/db/schema-accept-gate.js");
  const { freeReviewRuns, freeWorkflowStates } = await import("../src/db/schema-free-workflow.js");
  const { regressionEvidence } = await import("../src/db/schema-regression-evidence.js");
  const { readMeta, writeMeta } = await import("../src/im/meta.js");
  const { imOutcomes } = await import("../src/db/schema-im.js");
  const { claimOwnTurn, releaseTurn } = await import("../src/turn-lock.js");
  const { SystemNotifier } = await import("../src/system-notify.js");
  const { setTaskStatus } = await import("../src/status.js");
  const { makeEventFilter } = await import("../src/auth/event-filter.js");
  const { SINGLE_USER_ID } = await import("../src/auth/context.js");
  const { settleTaskStatus } = await import("../src/settle-status.js");
  const { and, eq } = await import("drizzle-orm");

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
  const review = (id: string, taskId: string, status: string, finished: boolean) => ({
    id, taskId, reviewerName: "审查者", agentType: "codex", checkMode: "free", targetKind: "workspace", status,
    createdAt: at(), updatedAt: at(), finishedAt: finished ? at() : null,
  });

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
  await db.insert(tasks).values(task({ id: "old-duet", title: "旧讨论", mode: "duet", status: "awaiting_review", createdAt: old }) as never);
  mkdirSync(join(stage, "runs", "old-duet", "transcript.jsonl"), { recursive: true }); // 讨论记录读不了（EISDIR）
  await db.insert(tasks).values(task({
    id: "old-reviewed", title: "审过又在续聊", status: "running", followUpFrom: "done", doneSeq: 1, workflowMode: "free", mode: "single", createdAt: old,
  }) as never);
  await db.insert(freeReviewRuns).values({ ...review("r-old", "old-reviewed", "passed", true), createdAt: old, updatedAt: old, finishedAt: old } as never);
  await notifier.baseline();
  assert.deepEqual(take(), [], "记底：已有的待验收、失败都不补推");
  assert.deepEqual(JSON.parse((await readMeta("system-notify-unbaselined"))!), ["old-duet"], "读不清的那一个记下来，别的照记");
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

  await db.insert(tasks).values(task({ id: "fresh", title: "记底之后跑完的", status: "done", doneSeq: 1, endedAt: at() }) as never);
  notifier.mark("fresh");
  await sleep(500);
  await notifier.run(async () => {});
  assert.deepEqual(kinds(take()), [["fresh", "accept"]], "有任务记底时没读清：不挡别的任务");

  await set("old-reviewed", { status: "paused", followUpFrom: null });
  assert.deepEqual(await reconcile("old-reviewed"), [], "记底时在续聊：启动前的老审查结论不当成新的");

  rmSync(join(stage, "runs", "old-duet", "transcript.jsonl"), { recursive: true });
  writeFileSync(join(stage, "runs", "old-duet", "transcript.jsonl"), `${JSON.stringify({ type: "duet.gate", open: true, version: 1 })}\n`);
  assert.deepEqual(await reconcile("old-duet"), [], "读得清了：记底前就在的闸口只补记，不补推");
  assert.deepEqual(JSON.parse((await readMeta("system-notify-unbaselined"))!), [], "补记过了");
  await set("old-duet", { duetGateVersion: 2 });
  assert.deepEqual(kinds(await reconcile("old-duet")), [["old-duet", "duet_gate"]], "补记之后照常比");

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

  // 读现状的半路上完成：视图那一读拿到 running 之后，另一处落 done#1（不等这边，自己去写）；身份那一读等它写完再读
  // （最多等一会儿）
  await db.insert(tasks).values(task({ id: "race", title: "读的时候完成了", status: "running" }) as never);
  const select = db.select.bind(db);
  let landed!: () => void;
  const completed = new Promise<void>((resolve) => { landed = resolve; });
  let viewRead = false;
  (db as { select: unknown }).select = (fields?: Record<string, unknown>) => {
    const builder = select(fields as never) as any;
    const gate = fields === undefined && !viewRead ? "view" : fields && "doneSeq" in fields ? "facts" : null;
    if (gate === "view") viewRead = true;
    if (!gate) return builder;
    const from = builder.from.bind(builder);
    builder.from = (...args: unknown[]) => {
      const query = from(...args);
      const where = query.where.bind(query);
      query.where = (...conds: unknown[]) => new Proxy(where(...conds), {
        get(target, prop, receiver) {
          if (prop !== "then") return Reflect.get(target, prop, receiver);
          return (ok: (rows: unknown) => unknown, bad: (error: unknown) => unknown) => (async () => {
            if (gate === "facts") await Promise.race([completed, sleep(100)]);
            const rows = await target;
            if (gate === "view") void set("race", { status: "done", doneSeq: 1, endedAt: at() }).then(() => landed());
            return rows;
          })().then(ok, bad);
        },
      });
      return query;
    };
    return builder;
  };
  let raced: Notice[];
  try {
    raced = await reconcile("race");
  } finally {
    (db as { select: unknown }).select = select;
  }
  await completed;
  assert.deepEqual(kinds(raced), [["race", "accept"]], "读的半路上完成了：发现库被写过，重读一遍照推，不先记进账");
  assert.deepEqual(await reconcile("race"), [], "不重复");

  // 读视图那一路会顺手写库、开事务（等前置完成的消息落锁存、核审查消息的归属）：对账不能等自己，别处的写也不干等
  const { scheduledMessages } = await import("../src/db/schema.js");
  for (const id of ["receiver", "predecessor", "bystander"]) {
    await db.insert(tasks).values(task({ id, title: id, status: "done", doneSeq: 1, endedAt: at() }) as never);
  }
  await reconcile("receiver", "predecessor", "bystander");
  for (const message of [
    { id: "m-after", mode: "after", afterTaskId: "predecessor", afterSeq: 0 },
    { id: "m-review", mode: "queued", origin: "review-settlement:generation" },
  ]) {
    await db.insert(scheduledMessages).values({ ...message, taskId: "receiver", text: "待发送", status: "pending", createdAt: at(), sendAt: at() } as never);
    const started = Date.now();
    const checking = notifier.run(() => notifier.reconcile(["receiver"]));
    await sleep(20);
    const writeStarted = Date.now();
    await set("bystander", { title: "别处改了一下" });
    const wrote = Date.now() - writeStarted;
    assert.deepEqual(await checking, [], `${message.id}：对上了`);
    assert.ok(wrote < 1_000, `${message.id}：别处的写不干等（${wrote}ms）`);
    assert.ok(Date.now() - started < 2_000, `${message.id}：对账不等自己`);
    take();
    await db.delete(scheduledMessages).where(eq(scheduledMessages.id, message.id));
  }

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

  const bulk = Array.from({ length: 6 }, (_, i) => `b${i}`);
  for (const id of bulk) await db.insert(tasks).values(task({ id, title: `批量 ${id}`, status: "running" }) as never);
  await reconcile(...bulk);
  for (const id of bulk) await set(id, { status: "done", doneSeq: 1, endedAt: at() });
  const many = await reconcile(...bulk);
  assert.deepEqual(many.map((notice) => notice.taskId), bulk, "一堆也一条一条推，各带着自己的任务");
  assert.deepEqual(await reconcile(...bulk), [], "都记了账");

  // ── ⑦ 自用模式：SSE 照推 ───────────────────────────────────────────────
  const filter = makeEventFilter({ kind: "single", userId: SINGLE_USER_ID, role: "admin", name: "me" } as never);
  await filter.refresh();
  assert.ok(filter.allow(done[0]!), "自用模式推给本机");
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
  assert.deepEqual(stopped.map((notice) => notice.kind), ["stopped"]);
  assert.equal(stopped[0]!.body, "已停止");
  assert.deepEqual(await reconcile("t7"), [], "不重复");
  // 真结算：跑着被停，回合记 stopped、任务落 canceled —— 只说一次
  await db.insert(tasks).values(task({ id: "t7b", title: "跑着被停", status: "running" }) as never);
  await reconcile("t7b");
  await turnOf("t7b", "stopped");
  assert.equal((await settleTaskStatus("t7b", 1, "canceled")).status, "canceled");
  assert.deepEqual(kinds(await reconcile("t7b")), [["t7b", "stopped"]], "回合停了、任务也 canceled：同一次停止只说一次");
  await set("t7b", { status: "backlog" });
  assert.deepEqual(await reconcile("t7b"), [], "停完重新排上、还没开新回合：不再说一遍");
  // 续聊被停，放回原 done
  await db.insert(tasks).values(task({ id: "t7c", title: "续聊被停", status: "done", doneSeq: 1, endedAt: at() }) as never);
  await reconcile("t7c");
  await set("t7c", { status: "running", followUpFrom: "done" });
  await reconcile("t7c");
  await turnOf("t7c", "stopped");
  assert.equal((await settleTaskStatus("t7c", 1, "canceled")).status, "done");
  const followStopped = await reconcile("t7c");
  assert.deepEqual(kinds(followStopped), [["t7c", "stopped"]], "续聊被停、放回原 done：说「已停止」，不说「完成了」");
  assert.equal(followStopped[0]!.body, "已停止");
  // 失败任务上的续聊被停：放回原来那次失败，只说停了
  await db.insert(tasks).values(task({ id: "t7d", title: "失败了又追问", status: "failed", endedAt: at() }) as never);
  await reconcile("t7d");
  await set("t7d", { status: "running", followUpFrom: "failed" });
  await reconcile("t7d");
  await turnOf("t7d", "stopped");
  assert.equal((await settleTaskStatus("t7d", 1, "canceled")).status, "failed");
  assert.deepEqual(kinds(await reconcile("t7d")), [["t7d", "stopped"]], "不再说「中断了，等你处理」");
  // 分组暂停
  await db.insert(tasks).values(task({ id: "t7e", title: "分组暂停", status: "running" }) as never);
  await reconcile("t7e");
  await turnOf("t7e", "stopped");
  assert.equal((await settleTaskStatus("t7e", 1, "paused")).status, "paused");
  const paused = await reconcile("t7e");
  assert.deepEqual(kinds(paused), [["t7e", "stopped"]]);
  assert.equal(paused[0]!.body, "已暂停");

  // ── ⑩ 后来派的审查 ─────────────────────────────────────────────────────
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

  for (const [id, status, kind, body] of [["t9", "stopped", "review_failed", "审查没通过"], ["t10", "passed", "review_passed", "审查通过"]] as const) {
    await db.insert(tasks).values(task({ id, title: "暂停着派审", status: "paused", workflowMode: "free", mode: "single" }) as never);
    await reconcile(id);
    await db.insert(freeReviewRuns).values(review(`r-${id}`, id, "reviewing", false) as never);
    assert.deepEqual(await reconcile(id), [], "审着：不推");
    // stopped 落在最后一轮（第 2 轮 / 最多 2 轮）才是用完了
    await db.update(freeReviewRuns).set({ status, currentRound: 2, finishedAt: at(), updatedAt: at() }).where(eq(freeReviewRuns.id, `r-${id}`));
    const concluded = await reconcile(id);
    assert.deepEqual(kinds(concluded), [[id, kind]], `暂停着的任务，审查最后 ${status}：推一条`);
    assert.equal(concluded[0]!.body, body);
    assert.deepEqual(await reconcile(id), [], "不重复");
  }

  // 自动修复复审的链（最多 2 轮）：结算先落 stopped，收尾再挂修复和续审预约
  const settleRound = async (runId: string, taskId: string, round: number, status: string) => {
    await db.update(freeReviewRuns).set({ status, currentRound: round, finishedAt: at(), updatedAt: at() }).where(eq(freeReviewRuns.id, runId));
    await db.insert(regressionEvidence).values({
      directory: `dir-${runId}`, taskId, generation: `${round}`, excludedMonitors: [],
      finalization: { kind: "free", payload: JSON.stringify({ run: { id: runId } }), done: [], steps: [] },
    } as never).onConflictDoUpdate({ target: regressionEvidence.directory, set: {
      generation: `${round}`, finalization: { kind: "free", payload: JSON.stringify({ run: { id: runId } }), done: [], steps: [] },
    } as never });
  };
  const finalize = async (runId: string, taskId: string, armed: boolean) => {
    await db.update(regressionEvidence).set({
      finalization: { kind: "free", payload: JSON.stringify({ run: { id: runId } }), done: [], steps: [], completed: true },
    } as never).where(eq(regressionEvidence.directory, `dir-${runId}`));
    await db.insert(freeWorkflowStates).values({ taskId, reviewArmed: armed, updatedAt: at() } as never)
      .onConflictDoUpdate({ target: freeWorkflowStates.taskId, set: { reviewArmed: armed, updatedAt: at() } });
  };
  /** 续审：同一条链放回 reviewing、轮数加一，finishedAt 不清（free-review-round.ts nextRound），预约被消费。 */
  const nextRound = async (runId: string, taskId: string, round: number) => {
    await db.update(freeReviewRuns).set({ status: "reviewing", currentRound: round, updatedAt: at() }).where(eq(freeReviewRuns.id, runId));
    await db.update(freeWorkflowStates).set({ reviewArmed: false, updatedAt: at() }).where(eq(freeWorkflowStates.taskId, taskId));
  };
  await db.insert(tasks).values(task({ id: "t11", title: "自动复审", status: "paused", workflowMode: "free", mode: "single" }) as never);
  await reconcile("t11");
  await db.insert(freeReviewRuns).values(review("r-t11", "t11", "reviewing", false) as never);
  await reconcile("t11");
  await settleRound("r-t11", "t11", 1, "stopped");
  assert.deepEqual(await reconcile("t11"), [], "第 1 轮没过、收尾还没挂上修复：不推");
  await finalize("r-t11", "t11", true);
  assert.deepEqual(await reconcile("t11"), [], "转修复、等续审：不推");
  await nextRound("r-t11", "t11", 2);
  assert.deepEqual(await reconcile("t11"), [], "续审在跑（finishedAt 还是上一轮的）：不推");
  await settleRound("r-t11", "t11", 2, "stopped");
  const exhausted = await reconcile("t11");
  assert.deepEqual(kinds(exhausted), [["t11", "review_failed"]], "最后一轮没过：推");
  assert.equal(exhausted[0]!.body, "审查没通过");
  await finalize("r-t11", "t11", false);
  assert.deepEqual(await reconcile("t11"), [], "不重复");
  await nextRound("r-t11", "t11", 3);
  assert.deepEqual(await reconcile("t11"), [], "同一条链再审一轮：审着不推");
  await settleRound("r-t11", "t11", 3, "stopped");
  await finalize("r-t11", "t11", false);
  assert.deepEqual(kinds(await reconcile("t11")), [["t11", "review_failed"]], "同一条链又没过：是新的一次结论");

  await db.insert(tasks).values(task({ id: "t12", title: "完成就审", status: "running", workflowMode: "free", mode: "single" }) as never);
  await db.insert(freeWorkflowStates).values({ taskId: "t12", reviewArmed: true, updatedAt: at() } as never);
  await reconcile("t12");
  await set("t12", { status: "done", doneSeq: 1, endedAt: at() });
  assert.deepEqual(await reconcile("t12"), [], "完成了、预约着审查：不推");
  await db.insert(freeReviewRuns).values(review("r-t12", "t12", "reviewing", false) as never);
  await db.update(freeWorkflowStates).set({ reviewArmed: false }).where(eq(freeWorkflowStates.taskId, "t12"));
  assert.deepEqual(await reconcile("t12"), [], "审着：不推");
  await settleRound("r-t12", "t12", 1, "stopped");
  assert.deepEqual(await reconcile("t12"), [], "转修复那一下：不推「审查没通过，等你决定」");
  await finalize("r-t12", "t12", true);
  await set("t12", { status: "running", followUpFrom: "done" });
  assert.deepEqual(await reconcile("t12"), [], "修复在跑：不推");
  await set("t12", { status: "done", doneSeq: 2, followUpFrom: null, endedAt: at() });
  assert.deepEqual(await reconcile("t12"), [], "修完了、等续审：不推");
  await nextRound("r-t12", "t12", 2);
  await settleRound("r-t12", "t12", 2, "passed");
  await finalize("r-t12", "t12", false);
  const repaired = await reconcile("t12");
  assert.deepEqual(kinds(repaired), [["t12", "accept"]]);
  assert.equal(repaired[0]!.body, "审查通过，等你验收");

  // ── ⑪ 团队调度台 ───────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "team", title: "团队", mode: "team", status: "idle" }) as never);
  await db.insert(tasks).values(task({ id: "worker", title: "成员", parentId: "team", status: "done", doneSeq: 1, useWorktree: false, endedAt: at() }) as never);
  assert.deepEqual(kinds(await reconcile("team")), [["team", "accept"]], "成员交付了：等验收");
  const leadTurn = async (outcome: string) => {
    await db.insert(sessions).values({ id: "s-team", taskId: "team", role: "lead", agentType: "claude", executor: "claude", startedAt: at() } as never)
      .onConflictDoNothing();
    const stamp = new Date(Date.now() + ++turnNo).toISOString();
    await db.insert(sessionTurns).values({ id: `turn-${turnNo}`, sessionId: "s-team", taskId: "team", startedAt: stamp, endedAt: stamp, outcome } as never);
  };
  await setTaskStatus("team", "running");
  await reconcile("team");
  await leadTurn("failed");
  await setTaskStatus("team", "idle");
  const leadFailed = await reconcile("team");
  assert.deepEqual(kinds(leadFailed), [["team", "interrupted"]], "调度台挂了回到待命：不说「完成了」");
  assert.equal(leadFailed[0]!.body, "这一轮中断了");
  await setTaskStatus("team", "running");
  await reconcile("team");
  await leadTurn("completed");
  await setTaskStatus("team", "idle");
  assert.deepEqual(kinds(await reconcile("team")), [["team", "accept"]], "调度台正常收口：新的一版");
  await db.delete(tasks).where(eq(tasks.id, "worker"));
  assert.deepEqual(await reconcile("team"), [], "删掉一个成员：不是新的一版");
  await db.insert(tasks).values(task({ id: "worker2", title: "新成员", parentId: "team", status: "backlog", useWorktree: false }) as never);
  assert.deepEqual(await reconcile("team"), [], "新加一个还没开工的成员：不是新的一版");
  await db.insert(tasks).values(task({ id: "worker3", title: "独立工作区成员", parentId: "team", status: "running", useWorktree: true }) as never);
  await setTaskStatus("worker3", "done", { completion: true });
  assert.deepEqual(await reconcile("team"), [], "开独立工作区的成员完成了：不算团队的一版");
  await setTaskStatus("worker2", "running");
  await setTaskStatus("worker2", "done", { completion: true });
  assert.deepEqual(kinds(await reconcile("team")), [["team", "accept"]], "共享执行者真完成了：新的一版");
  await db.update(tasks).set({ useWorktree: true }).where(eq(tasks.id, "worker3"));
  await db.update(tasks).set({ useWorktree: false }).where(eq(tasks.id, "worker3"));
  assert.deepEqual(await reconcile("team"), [], "成员换工作区：不是新的一版");

  // ── ⑭ 持续目标停住 ─────────────────────────────────────────────────────
  await db.insert(tasks).values(task({ id: "goal", title: "持续目标", status: "running", goalTurn: true }) as never);
  await reconcile("goal");
  await turnOf("goal", "completed");
  assert.equal((await settleTaskStatus("goal", 0, null)).status, "paused");
  const goalStopped = await reconcile("goal");
  assert.deepEqual(kinds(goalStopped), [["goal", "goal_stopped"]], "没交卷就停住：推");
  assert.equal(goalStopped[0]!.body, "持续目标停了，等你续跑");
  assert.deepEqual(await reconcile("goal"), [], "不重复");
  await setTaskStatus("goal", "running");
  await set("goal", { goalTurn: true });
  assert.deepEqual(await reconcile("goal"), [], "续跑起来：不推");
  await sleep(5);
  await turnOf("goal", "completed");
  assert.equal((await settleTaskStatus("goal", 0, null)).status, "paused");
  assert.deepEqual(kinds(await reconcile("goal")), [["goal", "goal_stopped"]], "又停住：是新的一回");
  await db.insert(tasks).values(task({ id: "checkpoint", title: "检查点", status: "running", resumePrompt: "继续" }) as never);
  await reconcile("checkpoint");
  await turnOf("checkpoint", "completed");
  assert.equal((await settleTaskStatus("checkpoint", 0, null)).status, "paused");
  assert.deepEqual(await reconcile("checkpoint"), [], "检查点暂停：会被叫起来，不推");

  // ── ⑫ 多人模式：被移出项目的成员 ───────────────────────────────────────
  const { users } = await import("../src/db/schema.js");
  const { writeSystemSetting } = await import("../src/app-settings.js");
  const { invalidateInstanceConfig } = await import("../src/auth/mode.js");
  const { addProjectMember, removeProjectMember } = await import("../src/auth/visibility.js");
  const { rememberTaskProject } = await import("../src/auth/event-filter.js");
  await db.insert(projects).values({ id: "p2", name: "保密项目", repoPath: join(stage, "repo"), apiKeys: null, createdAt: old } as never);
  await db.insert(users).values({ id: "u", name: "被移出的成员", role: "member", dirName: "u", status: "active", createdAt: at(), updatedAt: at() } as never);
  await writeSystemSetting("instanceMode", "multi");
  invalidateInstanceConfig();
  await addProjectMember({ projectId: "p2", userId: "u", role: "member", addedBy: null });
  await removeProjectMember("p2", "u");
  const secrets = Array.from({ length: 6 }, (_, i) => `secret-${i}`);
  for (const id of secrets) {
    await db.insert(tasks).values(task({ id, projectId: "p2", ownerUserId: "u", title: `移出后的标题 ${id}`, status: "running" }) as never);
    rememberTaskProject(id, "p2");
  }
  await reconcile(...secrets);
  for (const id of secrets) await set(id, { status: "done", doneSeq: 1, endedAt: at() });
  const secret = await reconcile(...secrets);
  assert.equal(secret.length, secrets.length);
  const member = makeEventFilter({ kind: "user", userId: "u", role: "member", name: "被移出的成员" } as never);
  await member.refresh();
  assert.deepEqual(secret.filter((notice) => member.allow(notice)), [], "看不见的项目：一条都不推给他");
  member.stop();

  await db.insert(users).values({ id: "m", name: "项目成员", role: "member", dirName: "m", status: "active", createdAt: at(), updatedAt: at() } as never);
  await addProjectMember({ projectId: "p2", userId: "m", role: "member", addedBy: null });
  await db.insert(tasks).values(task({ id: "cold", projectId: "p2", ownerUserId: "m", title: "重启时在跑", status: "running" }) as never);
  await reconcile("cold");
  await set("cold", { status: "failed", endedAt: at() });
  const cold = await reconcile("cold");
  assert.deepEqual(kinds(cold), [["cold", "failed"]]);
  const owner2 = makeEventFilter({ kind: "user", userId: "m", role: "member", name: "项目成员" } as never);
  await owner2.refresh();
  assert.ok(owner2.allow(cold[0]!), "归属缓存是冷的：有权限照推，不丢这一次");
  owner2.stop();

  // ── ⑬ 重启 ─────────────────────────────────────────────────────────────
  const restarted = new SystemNotifier((notice) => seen.push(notice));
  await db.insert(tasks).values(task({ id: "t13", title: "重启前后跑完的", status: "done", doneSeq: 1, endedAt: at() }) as never);
  await restarted.baseline();
  await restarted.run(() => restarted.reconcile(["t13"]));
  assert.deepEqual(kinds(take()), [["t13", "accept"]], "记过底不重记：记底之后的新事照推");
  // 老写法的账：审查结论只认链和落成什么
  await db.update(imOutcomes).set({ value: "r-t10:passed" })
    .where(and(eq(imOutcomes.appId, "navi:system-notify"), eq(imOutcomes.taskId, "t10"), eq(imOutcomes.kind, "reviewed")));
  await writeMeta("system-notify-format", "1");
  const upgraded = new SystemNotifier((notice) => seen.push(notice));
  await upgraded.baseline();
  await upgraded.run(() => upgraded.reconcile(["t10"]));
  assert.deepEqual(take(), [], "账的记法变了：重记一遍，不把老结论当新的");
  restarted.stop();
  upgraded.stop();

  // 补记进度存不进去：别的任务已经记了账的那几条照推，进度下次再存
  await db.insert(tasks).values(task({ id: "late-duet", title: "后来读得清的讨论", mode: "duet", status: "paused" }) as never);
  await writeMeta("system-notify-unbaselined", JSON.stringify(["late-duet"]));
  const progress = new SystemNotifier((notice) => seen.push(notice));
  await progress.baseline();
  await db.insert(tasks).values(task({ id: "t14", title: "同一批里完成的", status: "done", doneSeq: 1, endedAt: at() }) as never);
  await dbClient.executeMultiple(`CREATE TEMP TRIGGER reject_progress BEFORE INSERT ON im_meta WHEN NEW.key = 'system-notify-unbaselined'
    BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  await progress.run(() => progress.reconcile(["late-duet", "t14"]));
  assert.deepEqual(kinds(take()), [["t14", "accept"]], "存进度出错：同一批别的任务照推");
  await dbClient.executeMultiple("DROP TRIGGER reject_progress");
  await progress.run(() => progress.reconcile(["late-duet", "t14"]));
  assert.deepEqual(take(), [], "再对一次：不重复");
  assert.deepEqual(JSON.parse((await readMeta("system-notify-unbaselined"))!), [], "进度这次存上了");
  progress.stop();

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
