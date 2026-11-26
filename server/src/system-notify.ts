// 系统通知：任务到了要人看一眼的时刻 —— 跑完等验收、验收落章、验证 / 验收前置命令没过、跑挂了（中断）、被停下、停下来
// 等人拍板（提问、驳回待裁定、讨论闸口、持续目标没完成就停住）—— 往 SSE 上推一条 task.notify，开着的客户端（mac app、Windows app、浏览器）各自
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
// 记底按任务各记各的：有任务那一下读不清（讨论记录打不开），只把它记进 UNBASELINED，别的任务照常记完、照常推；它读得清
// 了再补记 —— 补记那一下分不清的只记账不推，带着发生时刻、发生在记底之后的（审查结论、回合中断、被停、持续目标停住）照推。不整份重记：
// 重记会把记底之后别的任务上真发生的事也当成历史。账的记法（FORMAT）变了等于没记过底，重记一遍。
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
/** 账的记法：哪一样认什么身份。改了身份的写法就加一，启动时按没记过底重记，不然老写法的账一比全是「新的」。 */
const FORMAT_KEY = "system-notify-format";
const FORMAT = "3";
/** 记底时没读清、还没补记的任务。 */
const UNBASELINED = "system-notify-unbaselined";
/** 上一次全量对账开始的时刻：这之后改过的任务下一次全量对账都带上。 */
const SWEPT = "system-notify-swept";
/** 一笔写锁里读几个任务：读得越多别处的写等得越久。 */
const BATCH = 20;
const FULL_SWEEP_MS = 10 * 60_000;

type Notice = Extract<ServerEvent, { type: "task.notify" }>;
type AccountTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class SystemNotifier {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** 等回合锁放开再对一次的任务（同一把锁只挂一个 waiter）。 */
  private settling = new Set<string>();
  /** 头一次全量对账之前：动静只攒着。 */
  private held = true;
  /** 记底的时刻和还没补记的任务（baseline 之后才有）。 */
  private baselinedAt: string | null = null;
  private unbaselined = new Set<string>();

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

  /** 头一回启用（或账的记法变了）：全部任务（归档的、团队执行者也算）此刻的样子只记账、不推。已经记过就只读回进度。 */
  async baseline(): Promise<void> {
    if (this.baselinedAt) return;
    const done = await readMeta(BASELINED);
    if (done && await readMeta(FORMAT_KEY) === FORMAT) {
      this.unbaselined = new Set(JSON.parse(await readMeta(UNBASELINED) ?? "[]") as string[]);
      this.baselinedAt = done;
      return;
    }
    const at = now();
    await reviewOutcomesSince();
    const all = await db.select({ id: tasks.id }).from(tasks);
    const missed = await this.run(() => this.reconcile(all.map((row) => row.id), { quiet: true }));
    if (missed.length) console.warn(`[navi] 系统通知记底时 ${missed.length} 个任务没读清，读得清了再补记`);
    this.unbaselined = new Set(missed);
    await writeMeta(UNBASELINED, JSON.stringify(missed));
    await writeMeta(SWEPT, at);
    await writeMeta(FORMAT_KEY, FORMAT);
    await writeMeta(BASELINED, at);
    this.baselinedAt = at;
  }

  /** 启动几秒后、定时：把可能要人管的任务对一遍。 */
  async full(): Promise<void> {
    // 记底本身出错（库写不进）就一直攒着：没记过底，账上缺的任务头一眼都会被当成新事。下一次定时再记
    await this.baseline();
    try {
      await this.sweep();
    } finally {
      // 全量对账出错也放开：之后的动静照常对，全量对账等下一次定时
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
      ...this.unbaselined,
    ])];
    this.dirty.clear();
    await this.run(() => this.reconcile(ids));
    await writeMeta(SWEPT, at);
  }

  /**
   * quiet = 只记账不推（记底）。一个任务记完账就把它那几条推出去，一个任务出错只记一句、不连累别的：先把一批都记了账
   * 再一起推的话，后面一个出错，前面记过账的就再也推不出去了（下一次对账身份已经一样）。返回没对上的任务。
   *
   * 读现状和改账在同一把写锁里（settle）：视图和身份是分好几次读的，不在锁里读，中间任务刚好落了完成，旧视图配新身份
   * ——「这一版不说」和「这一版是 done#1」凑在一起，账一记，那次完成就再也不说了；反过来新视图配旧身份，账上看着
   * 没变，这一次也不说了。
   */
  async reconcile(taskIds: string[], { quiet = false }: { quiet?: boolean } = {}): Promise<string[]> {
    await reviewOutcomesSince();
    const ids = await withTeamLeads(taskIds);
    const failed: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      let settled: Map<string, Notice[] | undefined>;
      try {
        settled = await this.settle(batch, quiet);
      } catch {
        // 一批在一笔事务里，一个出错整批回滚：一个一个重来，出错的那个不连累别的
        settled = new Map();
        for (const taskId of batch) {
          try {
            settled.set(taskId, (await this.settle([taskId], quiet)).get(taskId));
          } catch (error) {
            failed.push(taskId);
            console.error(`[navi] 系统通知对账出错 task=${taskId}:`, error);
          }
        }
      }
      for (const [taskId, notices] of settled) {
        // undefined = 这一下看不清现状（im/attention.ts viewsOf）：什么都没记，算没对上
        if (!notices) {
          failed.push(taskId);
          continue;
        }
        for (const notice of notices) this.publish(notice);
        if (!quiet && this.unbaselined.delete(taskId)) await writeMeta(UNBASELINED, JSON.stringify([...this.unbaselined]));
      }
    }
    return failed;
  }

  /**
   * 在写锁里把一批任务读一遍、按读到的改账，返回各自该弹的那几条（提交之后再弹）；undefined = 这一下看不清现状。
   * 全进程只有一条连接（db/node-sqlite-client.ts）：写锁开着时别处的写都等它收尾，锁里分几次读到的是同一刻的库。
   * 锁里除了账只读不写：别处的写要等这一笔，锁里拿根 db 写会等到自己超时。
   */
  private settle(batch: string[], quiet: boolean): Promise<Map<string, Notice[] | undefined>> {
    return db.transaction(async (tx) => {
      const [views, facts] = await Promise.all([viewsOf(batch), factsOf(batch)]);
      const out = new Map<string, Notice[] | undefined>();
      for (const taskId of batch) {
        if (!views.has(taskId)) {
          out.set(taskId, undefined);
          continue;
        }
        const view = views.get(taskId);
        const fact = facts.get(taskId);
        if (!view || !fact) {
          await tx.delete(imOutcomes).where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, taskId)));
          out.set(taskId, []);
          continue;
        }
        const mode = quiet ? "quiet" : this.unbaselined.has(taskId) ? "catchup" : "live";
        const entries = await entriesOf(view, fact);
        out.set(taskId, mode === "live" && this.stillSettling(taskId, view, entries) ? [] : await this.advance(tx, view, entries, mode));
      }
      return out;
    }, { behavior: "immediate" });
  }

  /** 有事要人管、回合锁却还占着：这一轮还在结算，先不动，锁放开再对（同 im/reconcile.ts stillSettling）。 */
  private stillSettling(taskId: string, view: TaskView, entries: Entry[]): boolean {
    const pending = (view.turn && view.turn.kind !== "duet_gate") || entries.some((entry) => entry.kind === "interrupt" || entry.kind === "stop" || entry.kind === "goal");
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

  /**
   * 把账改成此刻的样子，返回该弹的那几条。quiet = 记底，只记账；catchup = 记底时没读清的任务头一回补记：带着发生时刻、
   * 发生在记底之后的照常比、照常说，其余只记账（分不清是记底前还是记底后的，按历史算）。
   */
  private async advance(tx: AccountTx, view: TaskView, entries: Entry[], mode: "quiet" | "catchup" | "live"): Promise<Notice[]> {
    const task = view.task;
    const silent = view.teamWorker || !!task.archived || task.handoff?.direction === "out";
    const since = this.baselinedAt ?? "";
    const known = new Map((await tx.select().from(imOutcomes)
      .where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, task.id)))).map((row) => [row.kind, row.value]));
    const out: Notice[] = [];
    for (const entry of entries) {
      if (known.get(entry.kind) === entry.value) continue;
      const history = mode === "quiet" || (mode === "catchup" && !(entry.at && entry.at > since));
      if (!history && entry.later) continue;
      if (!history && entry.whenSaid && !entry.said && known.has(entry.kind)) continue;
      await tx.insert(imOutcomes).values({ appId: SINK, taskId: task.id, kind: entry.kind, value: entry.value, updatedAt: now() })
        .onConflictDoUpdate({ target: [imOutcomes.appId, imOutcomes.taskId, imOutcomes.kind], set: { value: entry.value, updatedAt: now() } });
      if (history || silent || !entry.said) continue;
      out.push(noticeOf(view, entry.said.kind, `${entry.kind}:${entry.value}`, entry.said.body));
    }
    return out;
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
