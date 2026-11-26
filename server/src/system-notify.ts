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
// 多记一样 turn = 上次看到的「下一步」（种类:代次，没有下一步记 "-"）。所以重复对账、事件重复都不会弹第二次，
// 重启期间发生的变化启动后照样补上。
//
// 第一次看到的任务只记账不推：头一回启用时不把历史上的待验收、失败补推一遍。水位（WATERMARK）之后新建的任务例外，
// 它的第一眼就是它头一件事。头一回启用时把没归档的任务全过一遍记底（baselined），之后的全量对账只看候选。
//
// 只推给任务主人（多人模式，auth/event-filter.ts）。没有客户端连着就没人收，不补发：错过的事侧栏照样标着。
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { ServerEvent, TaskNotifyKind } from "@navi/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { imOutcomes } from "./db/schema-im.js";
import { tasks } from "./db/schema.js";
import { openDisputeTargets } from "./free-review-dispute.js";
import { isTurnClaimed, whenTurnIdle } from "./turn-lock.js";
import { now } from "./util.js";
import { viewsOf, withTeamLeads, type TaskView, type Turn } from "./im/attention.js";
import { acceptedLabel, acceptSubtitle, KIND_LABEL } from "./im/cards.js";
import { readMeta, writeMeta } from "./im/meta.js";
import { outcomesOf, reviewOutcomesSince, staleOutcomeTasks } from "./im/outcomes.js";
import { scrubTitle } from "./im/scrub.js";

export const SINK = "navi:system-notify";
const WATERMARK = "system-notify-since";
const BASELINED = "system-notify-baselined";
const NONE = "-";
const BATCH = 40;
/** 同一个人一次对账里超过这么多条就合成一条：重启后补上一堆、一口气跑完一批，不该叮叮叮响一串。 */
export const DIGEST_OVER = 4;
const FULL_SWEEP_MS = 10 * 60_000;

type Notice = Extract<ServerEvent, { type: "task.notify" }>;

export class SystemNotifier {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** 等回合锁放开再对一次的任务（同一把锁只挂一个 waiter）。 */
  private settling = new Set<string>();
  private since: Promise<string> | null = null;

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
    if (this.timer) return;
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
    await this.watermark();
    await reviewOutcomesSince();
    const baselined = await readMeta(BASELINED);
    const candidates = await db.select({ id: tasks.id }).from(tasks).where(baselined ? and(
      eq(tasks.archived, false),
      or(
        isNotNull(tasks.question),
        inArray(tasks.status, ["failed", "done", "awaiting_review", "idle", "paused"]),
        eq(tasks.stage, "verify_failed"),
      ),
      or(sql`${tasks.stage} IS NULL`, sql`${tasks.stage} NOT IN ('accepted', 'merged')`),
    ) : eq(tasks.archived, false));
    const disputes = (await openDisputeTargets()).map((target) => target.taskId);
    const ids = [...new Set([...candidates.map((row) => row.id), ...disputes, ...await staleOutcomeTasks(SINK)])];
    await this.run(() => this.reconcile(ids));
    if (!baselined) await writeMeta(BASELINED, now());
  }

  async reconcile(taskIds: string[]): Promise<void> {
    const since = await this.watermark();
    const ids = await withTeamLeads(taskIds);
    const notices: Notice[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const views = await viewsOf(ids.slice(i, i + BATCH));
      for (const [taskId, view] of views) {
        if (!view) {
          await db.delete(imOutcomes).where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, taskId)));
          continue;
        }
        if (this.stillSettling(taskId, view)) continue;
        notices.push(...await this.advance(view, since));
      }
    }
    for (const notice of digest(notices)) this.publish(notice);
  }

  /** 有事要人管、回合锁却还占着：这一轮还在结算，先不动，锁放开再对（同 im/reconcile.ts stillSettling）。 */
  private stillSettling(taskId: string, view: TaskView): boolean {
    if (!view.turn || view.turn.kind === "duet_gate" || !isTurnClaimed(taskId)) return false;
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
  private async advance(view: TaskView, since: string): Promise<Notice[]> {
    const task = view.task;
    const turn = view.turn;
    const outcomes = await outcomesOf(view);
    const current = [{ kind: "turn", value: turn ? `${turn.kind}:${turn.generation}` : NONE }, ...outcomes];
    const quiet = view.teamWorker || !!task.archived || task.handoff?.direction === "out";
    return db.transaction(async (tx) => {
      const known = new Map((await tx.select().from(imOutcomes)
        .where(and(eq(imOutcomes.appId, SINK), eq(imOutcomes.taskId, task.id)))).map((row) => [row.kind, row.value]));
      // 头一眼只记账：水位之前就有的任务，那是历史；之后新建的，那就是它头一件事。
      const fresh = known.size > 0 || task.createdAt > since;
      const out: Notice[] = [];
      for (const entry of current) {
        if (known.get(entry.kind) === entry.value) continue;
        await tx.insert(imOutcomes).values({ appId: SINK, taskId: task.id, kind: entry.kind, value: entry.value, updatedAt: now() })
          .onConflictDoUpdate({ target: [imOutcomes.appId, imOutcomes.taskId, imOutcomes.kind], set: { value: entry.value, updatedAt: now() } });
        if (quiet || !fresh) continue;
        const said = entry.kind === "turn" ? (turn ? turnWords(view, turn) : null) : outcomeWords(view, entry);
        if (said) out.push(noticeOf(view, said.kind, `${entry.kind}:${entry.value}`, said.body));
      }
      return out;
    }, { behavior: "immediate" });
  }
}

function turnWords(view: TaskView, turn: Turn): { kind: TaskNotifyKind; body: string } {
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
function outcomeWords(view: TaskView, outcome: { kind: string; value: string; text?: string | null }): { kind: TaskNotifyKind; body: string } | null {
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

/** 起对账（server 启动时，预览实例不起）。头一次全量对账晚几秒：重启后页面要先连回来，早推了没人收。 */
export function startSystemNotify(): void {
  if (running) return;
  const notifier = new SystemNotifier();
  const unsubscribe = bus.subscribe((ev) => {
    switch (ev.type) {
      case "task.created":
      case "task.updated":
        notifier.mark(ev.task.id);
        break;
      case "task.status":
      case "task.stage":
      case "task.question":
      case "task.acceptGate":
      case "task.review":
      case "task.pendingMessages":
      case "duet.gate":
        notifier.mark(ev.taskId);
        break;
    }
  });
  const fullSoon = () => void notifier.full().catch((error) => console.error("[navi] 系统通知对账出错:", error));
  setTimeout(fullSoon, 5_000).unref?.();
  const sweep = setInterval(fullSoon, FULL_SWEEP_MS);
  sweep.unref?.();
  running = { notifier, unsubscribe, sweep };
}
