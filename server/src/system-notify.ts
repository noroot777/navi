// 系统通知：任务到了要人看一眼的时刻 —— 跑完等验收、验收落章、验证 / 验收前置命令没过、跑挂了（中断）、停下来等人
// 拍板（提问、驳回待裁定、讨论闸口）—— 往 SSE 上推一条 task.notify，开着的客户端（mac app、浏览器）各自弹系统通知。
// 什么时候弹、弹什么字都在这里定，客户端只管显示：几个客户端各判一遍，迟早一个弹一个不弹。
//
// 判据不另写一份：「此刻要人做哪件事」和它的代次用飞书推送那一份（im/attention.ts），「验收了 / 门禁出结果了 / 审查
// 通过了」用结局账那一份（im/outcomes.ts）。那两份已经把容易推错的情形挡掉了：结算途中、托盘里排着马上要送进去的
// 消息、审查链还没出结论、团队执行者、接力出去的。
//
// 也跟飞书一样靠对账驱动，不靠单个事件：bus 上的动静只把任务记成脏，稍后算一遍现状，和账上记的上一次比，变成一件
// 新的要人管的事才推。账记在 im_outcomes 里，app_id 用 SINK —— 飞书每个应用一本账，这里是另一本，同一套口径；
// 多记几样：seen = 见过它，turn:<种类> = 这种「下一步」上次见到的是哪一回，interrupt = 上次见到的那一轮挂掉的回合，stop = 上次见到
// 的那一次停止。所以重复对账、事件重复都不会弹第二次，重启期间发生的变化启动后照样补上。
//
// 「完成了，等你验收」认的是**真的又完成了一次**（tasks.done_seq，只有 completion 才加），不是任务此刻停在 done 上：
// 续聊挂了、被停了，结算把原来的 done 放回去，结束时刻也跟着刷新（status.ts），那不是新的一版。那一轮挂了另说一句
// （interrupt，认这一回合自己的结局 session_turns.outcome）。团队调度台的成果版本另有算法（task-result-version.ts），照旧。
//
// 第一次看到的任务只记账不推：头一回启用时不把历史上的待验收、失败补推一遍。两种例外：水位（WATERMARK）之后新建的
// 任务，它的第一眼就是它头一件事；这个进程起来之后真有过动静的任务（状态、阶段、提问、门禁、审查），那是刚发生的事。
// 头一回启用时把没归档的任务全过一遍记底（baselined），之后的全量对账只看候选。头一次全量对账之前收到的动静先攒着，
// 跟它一起算，不提前推（页面还没连回来，推了没人收）。
//
// 只推给任务主人（多人模式，auth/event-filter.ts）。没有客户端连着就没人收，不补发：错过的事侧栏照样标着。
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { ServerEvent, TaskNotifyKind } from "@navi/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { imOutcomes } from "./db/schema-im.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import { openDisputeTargets } from "./free-review-dispute.js";
import { isTurnClaimed, whenTurnIdle } from "./turn-lock.js";
import { now } from "./util.js";
import { acceptIdentityOf, viewsOf, withTeamLeads, type TaskView, type Turn } from "./im/attention.js";
import { acceptedLabel, acceptSubtitle, KIND_LABEL } from "./im/cards.js";
import { readMeta, writeMeta } from "./im/meta.js";
import { outcomesOf, reviewOutcomesSince, staleOutcomeTasks } from "./im/outcomes.js";
import { scrubTitle } from "./im/scrub.js";
import { NO_GATE } from "./task-human-gate.js";

export const SINK = "navi:system-notify";
const WATERMARK = "system-notify-since";
const BASELINED = "system-notify-baselined";
const BATCH = 40;
/** 同一个人一次对账里超过这么多条就合成一条：重启后补上一堆、一口气跑完一批，不该叮叮叮响一串。 */
export const DIGEST_OVER = 4;
const FULL_SWEEP_MS = 10 * 60_000;

type Notice = Extract<ServerEvent, { type: "task.notify" }>;
type Said = { kind: TaskNotifyKind; body: string };
/** 账上的一样：哪一种、此刻是哪一回、变了要说什么（null = 只记账）。 */
type Entry = { kind: string; value: string; said: Said | null };
/** 视图之外要现读的两样：完成过几次、最近一个回合（单飞会话上的）怎么收的。 */
type Facts = { doneSeq: number; lastTurn: { id: string; outcome: string | null } | null };

export class SystemNotifier {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** 等回合锁放开再对一次的任务（同一把锁只挂一个 waiter）。 */
  private settling = new Set<string>();
  private since: Promise<string> | null = null;
  /** 这个进程起来之后真有过动静的任务：头一眼也算新事（见文件头）。看过一眼就划掉。 */
  private live = new Set<string>();
  /** 头一次全量对账之前：动静只攒着。 */
  private held = true;

  constructor(private readonly publish: (notice: Notice) => void = (notice) => bus.publish(notice)) {}

  /** 对账排成一条链：两次对账不会交错改同一本账。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  /** bus 订阅里调：只记下 id，什么都不读（订阅回调里抛错会打断发布方）。live = 这是一次真的动静，不是改个标题。 */
  mark(taskId: string, live = false): void {
    if (this.stopped || !taskId) return;
    if (live) this.live.add(taskId);
    this.dirty.add(taskId);
    this.schedule();
  }

  private schedule(): void {
    if (this.held || this.timer || !this.dirty.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const ids = [...this.dirty];
      this.dirty.clear();
      void this.run(() => this.reconcile(ids)).catch((error) => console.error("[navi] 系统通知对账出错:", error));
    }, 300);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 水位：头一次调用时落下，之后一直是这个时刻。 */
  watermark(): Promise<string> {
    this.since ??= (async () => {
      const stored = await readMeta(WATERMARK);
      if (stored) return stored;
      const at = now();
      await writeMeta(WATERMARK, at);
      return at;
    })().catch((error) => { this.since = null; throw error; });
    return this.since;
  }

  /** 启动时、定时：把可能要人管的任务对一遍。头一回是没归档的全部（记底）。 */
  async full(): Promise<void> {
    try {
      await this.fullOnce();
    } finally {
      // 头一次出错也放开：之后的动静照常对，全量对账等下一次定时
      this.held = false;
      this.schedule();
    }
  }

  private async fullOnce(): Promise<void> {
    await this.watermark();
    await reviewOutcomesSince();
    const baselined = await readMeta(BASELINED);
    const candidates = await db.select({ id: tasks.id }).from(tasks).where(baselined ? and(
      eq(tasks.archived, false),
      or(
        isNotNull(tasks.question),
        inArray(tasks.status, ["failed", "canceled", "done", "awaiting_review", "idle", "paused"]),
        eq(tasks.stage, "verify_failed"),
      ),
      or(sql`${tasks.stage} IS NULL`, sql`${tasks.stage} NOT IN ('accepted', 'merged')`),
    ) : eq(tasks.archived, false));
    const disputes = (await openDisputeTargets()).map((target) => target.taskId);
    const ids = [...new Set([...candidates.map((row) => row.id), ...disputes, ...await staleOutcomeTasks(SINK), ...this.dirty])];
    this.dirty.clear();
    await this.run(() => this.reconcile(ids));
    if (!baselined) await writeMeta(BASELINED, now());
  }

  async reconcile(taskIds: string[]): Promise<void> {
    const since = await this.watermark();
    const ids = await withTeamLeads(taskIds);
    const notices: Notice[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const [views, facts] = await Promise.all([viewsOf(batch), factsOf(batch)]);
      for (const [taskId, view] of views) {
        if (!view) {
          await db.delete(imOutcomes).where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, taskId)));
          continue;
        }
        const entries = await entriesOf(view, facts.get(taskId) ?? { doneSeq: 0, lastTurn: null });
        if (this.stillSettling(taskId, view, entries)) continue;
        notices.push(...await this.advance(view, entries, since));
      }
    }
    for (const notice of digest(notices)) this.publish(notice);
  }

  /** 有事要人管、回合锁却还占着：这一轮还在结算，先不动，锁放开再对（同 im/reconcile.ts stillSettling）。 */
  private stillSettling(taskId: string, view: TaskView, entries: Entry[]): boolean {
    const pending = (view.turn && view.turn.kind !== "duet_gate") || entries.some((entry) => entry.kind === "interrupt");
    if (!pending || !isTurnClaimed(taskId)) return false;
    if (!this.settling.has(taskId)) {
      this.settling.add(taskId);
      whenTurnIdle(taskId, () => {
        this.settling.delete(taskId);
        this.mark(taskId);
      });
    }
    return true;
  }

  /** 把账改成此刻的样子，返回该弹的那几条（下一步在前，结局按发生的先后）。 */
  private async advance(view: TaskView, entries: Entry[], since: string): Promise<Notice[]> {
    const task = view.task;
    const quiet = view.teamWorker || !!task.archived || task.handoff?.direction === "out";
    const live = this.live.delete(task.id);
    return db.transaction(async (tx) => {
      const known = new Map((await tx.select().from(imOutcomes)
        .where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, task.id)))).map((row) => [row.kind, row.value]));
      // 头一眼只记账：水位之前就有、这个进程起来后也没动过的任务，那是历史（见文件头）。
      const fresh = known.size > 0 || task.createdAt > since || live;
      const out: Notice[] = [];
      for (const entry of entries) {
        if (known.get(entry.kind) === entry.value) continue;
        await tx.insert(imOutcomes).values({ appId: SINK, taskId: task.id, kind: entry.kind, value: entry.value, updatedAt: now() })
          .onConflictDoUpdate({ target: [imOutcomes.appId, imOutcomes.taskId, imOutcomes.kind], set: { value: entry.value, updatedAt: now() } });
        if (quiet || !fresh || !entry.said) continue;
        out.push(noticeOf(view, entry.said.kind, `${entry.kind}:${entry.value}`, entry.said.body));
      }
      return out;
    }, { behavior: "immediate" });
  }
}

/** 一批任务完成过几次、最近一个单飞回合怎么收的。 */
async function factsOf(taskIds: string[]): Promise<Map<string, Facts>> {
  const rows = await db.select({ id: tasks.id, doneSeq: tasks.doneSeq }).from(tasks).where(inArray(tasks.id, taskIds));
  const out = new Map<string, Facts>();
  for (const row of rows) {
    const last = (await db.select({ id: sessionTurns.id, outcome: sessionTurns.outcome }).from(sessionTurns)
      .innerJoin(sessions, and(eq(sessions.id, sessionTurns.sessionId), eq(sessions.role, "single")))
      .where(eq(sessionTurns.taskId, row.id)).orderBy(desc(sessionTurns.startedAt)).limit(1)).at(0);
    out.set(row.id, { doneSeq: row.doneSeq, lastTurn: last ?? null });
  }
  return out;
}

/** 此刻账上该是什么样。下一步在前，结局按发生的先后。 */
async function entriesOf(view: TaskView, facts: Facts): Promise<Entry[]> {
  const task = view.task;
  const turn = view.turn;
  // 见过这个任务：之后它再有什么都不是历史了（此刻没事要人管的任务账上也得有一行）
  const entries: Entry[] = [{ kind: "seen", value: "1", said: null }];
  if (turn) entries.push({ kind: `turn:${turn.kind}`, value: turnIdentity(view, turn, facts.doneSeq), said: turnWords(view, turn) });
  // 这一轮挂了、任务却没落失败（续聊挂了，原来的结果放回去了）：单说一句。落了失败的那一下由上面的 failed 说，
  // 这里只记账；还在跑（或刚收口、还没结算）的不看。
  const broken = facts.lastTurn?.outcome === "failed" ? facts.lastTurn.id : null;
  if (broken && task.status !== "running" && task.status !== "queued") {
    const settledAsFailure = task.status === "failed" || task.status === "canceled";
    entries.push({
      kind: "interrupt", value: broken,
      said: settledAsFailure ? null : { kind: "interrupted", body: task.status === "done" ? "这一轮中断了，结果还是上一版" : "这一轮中断了" },
    });
  }
  if (task.status === "canceled") entries.push({ kind: "stop", value: task.endedAt ?? task.updatedAt, said: { kind: "canceled", body: "已停止" } });
  for (const outcome of await outcomesOf(view)) entries.push({ kind: outcome.kind, value: outcome.value, said: outcomeWords(view, outcome) });
  return entries;
}

/**
 * 这件事是第几回。等验收、验证没过认完成次数：attention.ts 的成果版本是结束时刻，原样放回 done 也会刷新它（见文件头）。
 * 等验收还带着停在哪一道关上（中途放行一道、停到下一道，是新的一回）。团队调度台的成果另算，用原来的代次。
 */
function turnIdentity(view: TaskView, turn: Turn, doneSeq: number): string {
  if (view.task.mode === "team" && !view.task.parentId) return turn.generation;
  if (turn.kind === "verify_failed") return `done#${doneSeq}`;
  if (turn.kind !== "accept") return turn.generation;
  const { humanGate } = acceptIdentityOf(turn.generation);
  return humanGate === NO_GATE ? `done#${doneSeq}` : `done#${doneSeq}|${humanGate}`;
}

function turnWords(view: TaskView, turn: Turn): Said {
  switch (turn.kind) {
    case "question": {
      const asked = scrubTitle(turn.items[0]?.question ?? view.task.question, 120);
      return { kind: turn.kind, body: `${KIND_LABEL.question}：${asked}` };
    }
    case "failed": return { kind: turn.kind, body: "中断了，等你处理" };
    case "dispute": return { kind: turn.kind, body: `${KIND_LABEL.dispute}，等你裁定` };
    case "accept": return { kind: turn.kind, body: acceptSubtitle(turn) };
    default: return { kind: turn.kind, body: KIND_LABEL[turn.kind] };
  }
}

/** 结局变成这样要不要说、说什么。门禁通过不单说：紧跟着就是验收落章那一条，或者交回任务接着跑。 */
function outcomeWords(view: TaskView, outcome: { kind: string; value: string; text?: string | null }): Said | null {
  if (!outcome.text) return null;
  if (outcome.kind === "result") return { kind: "accepted", body: acceptedLabel(view.task) };
  if (outcome.kind === "gate") return outcome.value.endsWith(":failed") ? { kind: "gate_failed", body: "验收前置命令没通过" } : null;
  if (outcome.kind === "review") return { kind: "review_passed", body: "审查通过" };
  return null;
}

function noticeOf(view: TaskView, kind: TaskNotifyKind, identity: string, body: string): Notice {
  return {
    type: "task.notify",
    taskId: view.task.id,
    projectId: view.task.projectId,
    ownerUserId: view.ownerUserId,
    kind,
    key: `${view.task.id}:${identity}`,
    title: scrubTitle(view.task.title),
    subtitle: view.projectName.trim() ? scrubTitle(view.projectName, 30) : "",
    body,
  };
}

/** 同一个人这一次超过 DIGEST_OVER 条：合成一条，列几个标题。 */
export function digest(notices: Notice[]): Notice[] {
  const byOwner = new Map<string | null, Notice[]>();
  for (const notice of notices) byOwner.set(notice.ownerUserId, [...(byOwner.get(notice.ownerUserId) ?? []), notice]);
  const out: Notice[] = [];
  for (const [ownerUserId, items] of byOwner) {
    if (items.length <= DIGEST_OVER) {
      out.push(...items);
      continue;
    }
    const titles = [...new Set(items.map((item) => `「${item.title}」`))];
    out.push({
      type: "task.notify", taskId: null, projectId: null, ownerUserId, kind: "digest",
      key: `digest:${items[0]!.key}:${items.length}`,
      title: `${items.length} 件事等你看`,
      subtitle: "",
      body: titles.length > 3 ? `${titles.slice(0, 3).join("、")} 等 ${titles.length} 个任务` : titles.join("、"),
    });
  }
  return out;
}

let running: { notifier: SystemNotifier; unsubscribe: () => void; sweep: ReturnType<typeof setInterval> } | null = null;

/** 起对账（server 启动时，预览实例不起）。头一次全量对账晚几秒：重启后页面要先连回来，早推了没人收；这几秒里的动静攒着跟它一起算。 */
export function startSystemNotify(): void {
  if (running) return;
  const notifier = new SystemNotifier();
  const unsubscribe = bus.subscribe((ev) => {
    switch (ev.type) {
      case "task.created":
      case "task.updated":
        notifier.mark(ev.task.id);
        break;
      case "task.pendingMessages":
        notifier.mark(ev.taskId);
        break;
      case "task.status":
      case "task.stage":
      case "task.question":
      case "task.acceptGate":
      case "task.review":
      case "duet.gate":
        notifier.mark(ev.taskId, true);
        break;
    }
  });
  const fullSoon = () => void notifier.full().catch((error) => console.error("[navi] 系统通知对账出错:", error));
  setTimeout(fullSoon, 5_000).unref?.();
  const sweep = setInterval(fullSoon, FULL_SWEEP_MS);
  sweep.unref?.();
  running = { notifier, unsubscribe, sweep };
}
