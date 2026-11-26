// 系统通知：任务到了要人看一眼的时刻 —— 跑完等验收、验收落章、验证 / 验收前置命令没过、跑挂了（中断）、被停下、停下来
// 等人拍板（提问、驳回待裁定、讨论闸口）—— 往 SSE 上推一条 task.notify，开着的客户端（mac app、Windows app、浏览器）各自
// 弹系统通知。什么时候弹、弹什么字都在这里定，客户端只管显示：几个客户端各判一遍，迟早一个弹一个不弹。
//
// 判据不另写一份：「此刻要人做哪件事」用飞书推送那一份（im/attention.ts），「验收了 / 门禁出结果了 / 审查通过了」用结局账
// 那一份（im/outcomes.ts）。那两份已经把容易推错的情形挡掉了：结算途中、托盘里排着马上要送进去的消息、审查链还没出结论、
// 团队执行者、接力出去的。每件事认它**自己的**身份（system-notify-facts.ts），不认「任务此刻停在哪」。
//
// 也跟飞书一样靠对账驱动，不靠单个事件：bus 上的动静只把任务记成脏，稍后算一遍现状，和账上记的上一次比，变成一件新的
// 要人管的事才推。账记在 im_outcomes 里，app_id 用 SINK —— 飞书每个应用一本账，这里是另一本。所以重复对账、事件重复都
// 不会弹第二次，重启期间发生的变化启动后照样补上。
//
// 记底：头一回启用时不把历史上的待验收、失败补推一遍 —— 启动时、**在收拾上一个进程留下的任务之前**（main.ts），把全部任务
// 此刻的样子记一遍底（baseline）。之后账上没有的任务就是新建的，它的头一眼就是它头一件事；启动收拾出来的中断、头几秒里
// 跑完的，都是记底之后发生的，照常比、照常推。不靠水位、不靠这个进程收到过什么动静去猜「是不是新的」。
//
// 全量对账（启动几秒后、之后定时）找候选：此刻可能要人管的状态，加上上次全量对账之后改过的任务、有回合收口的任务，
// 加上结局账对不上的。事件丢了、订阅之前发生的，都在这里补上。头一次全量对账之前收到的动静先攒着，跟它一起算，
// 不提前推（重启后页面要先连回来，推了没人收）。
//
// 只推给任务主人（多人模式，auth/event-filter.ts）。没有客户端连着就没人收，不补发：错过的事侧栏照样标着。
import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { ServerEvent, TaskNotifyKind } from "@navi/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { imOutcomes } from "./db/schema-im.js";
import { sessionTurns, tasks } from "./db/schema.js";
import { openDisputeTargets } from "./free-review-dispute.js";
import { isTurnClaimed, whenTurnIdle } from "./turn-lock.js";
import { now } from "./util.js";
import { viewsOf, withTeamLeads, type TaskView } from "./im/attention.js";
import { readMeta, writeMeta } from "./im/meta.js";
import { reviewOutcomesSince, staleOutcomeTasks } from "./im/outcomes.js";
import { scrubTitle } from "./im/scrub.js";
import { entriesOf, factsOf, type Entry } from "./system-notify-facts.js";

export const SINK = "navi:system-notify";
const BASELINED = "system-notify-baselined";
/** 上一次全量对账开始的时刻：这之后改过的任务下一次全量对账都带上。 */
const SWEPT = "system-notify-swept";
const BATCH = 40;
const FULL_SWEEP_MS = 10 * 60_000;

type Notice = Extract<ServerEvent, { type: "task.notify" }>;

export class SystemNotifier {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** 等回合锁放开再对一次的任务（同一把锁只挂一个 waiter）。 */
  private settling = new Set<string>();
  /** 头一次全量对账之前：动静只攒着。 */
  private held = true;

  constructor(private readonly publish: (notice: Notice) => void = (notice) => bus.publish(notice)) {}

  /** 对账排成一条链：两次对账不会交错改同一本账。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  /** bus 订阅里调：只记下 id，什么都不读（订阅回调里抛错会打断发布方）。 */
  mark(taskId: string): void {
    if (this.stopped || !taskId) return;
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

  /** 头一回启用：全部任务（归档的、团队执行者也算）此刻的样子只记账、不推。已经记过就什么都不做。 */
  async baseline(): Promise<void> {
    if (await readMeta(BASELINED)) return;
    const at = now();
    await reviewOutcomesSince();
    const all = await db.select({ id: tasks.id }).from(tasks);
    await this.run(() => this.reconcile(all.map((row) => row.id), { quiet: true }));
    await writeMeta(SWEPT, at);
    await writeMeta(BASELINED, at);
  }

  /** 启动几秒后、定时：把可能要人管的任务对一遍。 */
  async full(): Promise<void> {
    try {
      await this.baseline();
      await this.sweep();
    } finally {
      // 头一次出错也放开：之后的动静照常对，全量对账等下一次定时
      this.held = false;
      this.schedule();
    }
  }

  private async sweep(): Promise<void> {
    const at = now();
    const since = (await readMeta(SWEPT)) ?? at;
    await reviewOutcomesSince();
    const candidates = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.archived, false),
      or(
        isNotNull(tasks.question),
        inArray(tasks.status, ["failed", "canceled", "done", "awaiting_review", "idle", "paused"]),
        eq(tasks.stage, "verify_failed"),
        gt(tasks.updatedAt, since),
      ),
      or(sql`${tasks.stage} IS NULL`, sql`${tasks.stage} NOT IN ('accepted', 'merged')`, gt(tasks.updatedAt, since)),
    ));
    const closed = await db.selectDistinct({ id: sessionTurns.taskId }).from(sessionTurns).where(gt(sessionTurns.endedAt, since));
    const disputes = (await openDisputeTargets()).map((target) => target.taskId);
    const ids = [...new Set([
      ...candidates.map((row) => row.id), ...closed.map((row) => row.id), ...disputes, ...await staleOutcomeTasks(SINK), ...this.dirty,
    ])];
    this.dirty.clear();
    await this.run(() => this.reconcile(ids));
    await writeMeta(SWEPT, at);
  }

  /**
   * quiet = 只记账不推（记底）。一个任务记完账就把它那几条推出去，一个任务出错只记一句、不连累别的：先把一批都记了账
   * 再一起推的话，后面一个出错，前面记过账的就再也推不出去了（下一次对账身份已经一样）。
   */
  async reconcile(taskIds: string[], { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
    const ids = await withTeamLeads(taskIds);
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const [views, facts] = await Promise.all([viewsOf(batch), factsOf(batch)]);
      for (const [taskId, view] of views) {
        try {
          const fact = facts.get(taskId);
          if (!view || !fact) {
            await db.delete(imOutcomes).where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, taskId)));
            continue;
          }
          const entries = await entriesOf(view, fact);
          if (!quiet && this.stillSettling(taskId, view, entries)) continue;
          for (const notice of await this.advance(view, entries, quiet)) this.publish(notice);
        } catch (error) {
          console.error(`[navi] 系统通知对账出错 task=${taskId}:`, error);
        }
      }
    }
  }

  /** 有事要人管、回合锁却还占着：这一轮还在结算，先不动，锁放开再对（同 im/reconcile.ts stillSettling）。 */
  private stillSettling(taskId: string, view: TaskView, entries: Entry[]): boolean {
    const pending = (view.turn && view.turn.kind !== "duet_gate") || entries.some((entry) => entry.kind === "interrupt" || entry.kind === "stop");
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

  /** 把账改成此刻的样子，返回该弹的那几条。 */
  private async advance(view: TaskView, entries: Entry[], quiet: boolean): Promise<Notice[]> {
    const task = view.task;
    const silent = quiet || view.teamWorker || !!task.archived || task.handoff?.direction === "out";
    return db.transaction(async (tx) => {
      const known = new Map((await tx.select().from(imOutcomes)
        .where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, task.id)))).map((row) => [row.kind, row.value]));
      const out: Notice[] = [];
      for (const entry of entries) {
        if (known.get(entry.kind) === entry.value) continue;
        if (entry.whenSaid && !entry.said && known.has(entry.kind)) continue;
        await tx.insert(imOutcomes).values({ appId: SINK, taskId: task.id, kind: entry.kind, value: entry.value, updatedAt: now() })
          .onConflictDoUpdate({ target: [imOutcomes.appId, imOutcomes.taskId, imOutcomes.kind], set: { value: entry.value, updatedAt: now() } });
        if (silent || !entry.said) continue;
        out.push(noticeOf(view, entry.said.kind, `${entry.kind}:${entry.value}`, entry.said.body));
      }
      return out;
    }, { behavior: "immediate" });
  }
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

let shared: SystemNotifier | null = null;
let running: { unsubscribe: () => void; sweep: ReturnType<typeof setInterval> } | null = null;
const notifier = () => (shared ??= new SystemNotifier());

/** 记底（server 启动时，收拾上一个进程留下的任务之前；预览实例不调）。见文件头「记底」。 */
export function baselineSystemNotify(): Promise<void> {
  return notifier().baseline();
}

/** 起对账（server 启动时，预览实例不起）。头一次全量对账晚几秒：重启后页面要先连回来，早推了没人收；这几秒里的动静攒着跟它一起算。 */
export function startSystemNotify(): void {
  if (running) return;
  const current = notifier();
  const unsubscribe = bus.subscribe((ev) => {
    switch (ev.type) {
      case "task.created":
      case "task.updated":
        current.mark(ev.task.id);
        break;
      case "task.status":
      case "task.stage":
      case "task.question":
      case "task.acceptGate":
      case "task.review":
      case "task.pendingMessages":
      case "duet.gate":
        current.mark(ev.taskId);
        break;
    }
  });
  const fullSoon = () => void current.full().catch((error) => console.error("[navi] 系统通知对账出错:", error));
  setTimeout(fullSoon, 5_000).unref?.();
  const sweep = setInterval(fullSoon, FULL_SWEEP_MS);
  sweep.unref?.();
  running = { unsubscribe, sweep };
}
