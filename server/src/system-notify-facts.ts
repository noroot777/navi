// 系统通知的「此刻账上该是什么样」（system-notify.ts 拿它跟账上记的上一次比）。
//
// 每一样都是一件事**自己的**身份，跟此刻是不是正好停在那一步无关，所以不在那一步时也照记：
//   seen           见过这个任务（此刻没事要人管的任务账上也得有一行，之后它再有什么都不是历史）
//   accept         这一版成果：完成过几次（tasks.done_seq，只有真完成才加）+ 停在哪一道「等我点头」+ 最近一次审查的结论。
//                  只在此刻正等验收时说话（说法跟着审查结论走：完成了 / 审查通过 / 审查没通过），账也只在那时、或者头一回
//                  见到这个任务时记：完成之后还要先验证、先审、托盘里的消息先送进去，那几步里身份已经是新的，等它真停到
//                  等验收上才说，跟上一次说过的比。
//                  不认结束时刻：续聊挂了、被停了，结算把原来的 done 放回去，结束时刻也跟着刷新（status.ts），那不是新的一版。
//                  也不能只在等验收时才记：先看到的是续聊在跑，之后放回原 done，那不是新的完成（第 2 轮审查 1.1.1 复发）。
//                  团队调度台的成果另有算法（task-result-version.ts），照用。
//   verify         验证没过那一版：完成过几次 + 跑完过几轮验证。同一版重新验证又没过也是新的一回。记账时机同 accept。
//   turn:<种类>    其余几种「下一步」（提问、失败、待裁定、讨论闸口）上次见到的是哪一回，代次同 im/attention.ts。
//   interrupt      最近一个单飞回合挂了、任务却没落失败（续聊挂了，原来的结果还在）：那一回合。落了失败的由 turn:failed 说。
//   stop           被停下（canceled）的那一次。
//   result/gate/review  结局账，同 im/outcomes.ts。
import { and, desc, eq, inArray } from "drizzle-orm";
import type { TaskNotifyKind } from "@navi/shared";
import { db } from "./db/index.js";
import { freeReviewRuns } from "./db/schema-free-workflow.js";
import { sessions, sessionTurns, tasks } from "./db/schema.js";
import type { TaskView, Turn } from "./im/attention.js";
import { acceptedLabel, acceptSubtitle, KIND_LABEL } from "./im/cards.js";
import { outcomesOf } from "./im/outcomes.js";
import { scrubTitle } from "./im/scrub.js";
import { humanGateOf, NO_GATE } from "./task-human-gate.js";
import { resultVersionOf } from "./task-result-version.js";

export type Said = { kind: TaskNotifyKind; body: string };
/**
 * 账上的一样：哪一种、此刻是哪一回、变了要说什么（null = 只记账）。
 * whenSaid = 只在要说话的时候（或者账上还没有这一样时）记，见文件头 accept。
 */
export type Entry = { kind: string; value: string; said: Said | null; whenSaid?: true };

/** 视图之外要现读的几样。 */
export interface Facts {
  doneSeq: number;
  verifyRounds: number;
  humanGate: string;
  /** 最近一次（工作区）审查：出了结论才有 status。 */
  review: { id: string; status: string; finished: boolean } | null;
  /** 最近一个单飞回合。 */
  lastTurn: { id: string; outcome: string | null } | null;
}

export async function factsOf(taskIds: string[]): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  if (!taskIds.length) return out;
  const rows = await db.select({ id: tasks.id, doneSeq: tasks.doneSeq, verifyRounds: tasks.verifyRounds, humanGateId: tasks.humanGateId })
    .from(tasks).where(inArray(tasks.id, taskIds));
  for (const row of rows) {
    const [turn, review] = await Promise.all([
      db.select({ id: sessionTurns.id, outcome: sessionTurns.outcome }).from(sessionTurns)
        .innerJoin(sessions, and(eq(sessions.id, sessionTurns.sessionId), eq(sessions.role, "single")))
        .where(eq(sessionTurns.taskId, row.id)).orderBy(desc(sessionTurns.startedAt)).limit(1),
      db.select({ id: freeReviewRuns.id, status: freeReviewRuns.status, finishedAt: freeReviewRuns.finishedAt }).from(freeReviewRuns)
        .where(and(eq(freeReviewRuns.taskId, row.id), eq(freeReviewRuns.targetKind, "workspace")))
        .orderBy(desc(freeReviewRuns.createdAt)).limit(1),
    ]);
    const latest = review.at(0);
    out.set(row.id, {
      doneSeq: row.doneSeq,
      verifyRounds: row.verifyRounds,
      humanGate: humanGateOf(row),
      review: latest ? { id: latest.id, status: latest.status, finished: !!latest.finishedAt } : null,
      lastTurn: turn.at(0) ?? null,
    });
  }
  return out;
}

const isTeamLead = (view: TaskView) => view.task.mode === "team" && !view.task.parentId;

/** 这一版成果的身份（见文件头 accept）。 */
async function acceptIdentity(view: TaskView, facts: Facts): Promise<string> {
  const result = isTeamLead(view) ? await resultVersionOf(view.task) : `done#${facts.doneSeq}`;
  const gate = facts.humanGate === NO_GATE ? "" : `|${facts.humanGate}`;
  const review = facts.review?.finished ? `|review:${facts.review.id}:${facts.review.status}` : "";
  return `${result}${gate}${review}`;
}

/** 此刻账上该是什么样。下一步在前，结局按发生的先后。 */
export async function entriesOf(view: TaskView, facts: Facts): Promise<Entry[]> {
  const task = view.task;
  const turn = view.turn;
  const entries: Entry[] = [
    { kind: "seen", value: "1", said: null },
    {
      kind: "accept", value: await acceptIdentity(view, facts), whenSaid: true,
      said: turn?.kind === "accept" ? { kind: "accept", body: acceptSubtitle(turn) } : null,
    },
    {
      kind: "verify", value: `done#${facts.doneSeq}|v#${facts.verifyRounds}`, whenSaid: true,
      said: turn?.kind === "verify_failed" ? { kind: "verify_failed", body: KIND_LABEL.verify_failed } : null,
    },
  ];
  if (turn && turn.kind !== "accept" && turn.kind !== "verify_failed") {
    entries.push({ kind: `turn:${turn.kind}`, value: turn.generation, said: turnWords(view, turn) });
  }
  // 还在跑（或刚收口、还没结算）的不看：结局还没定。
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

function turnWords(view: TaskView, turn: Turn): Said {
  switch (turn.kind) {
    case "question": {
      const asked = scrubTitle(turn.items[0]?.question ?? view.task.question, 120);
      return { kind: turn.kind, body: `${KIND_LABEL.question}：${asked}` };
    }
    case "failed": return { kind: turn.kind, body: "中断了，等你处理" };
    case "dispute": return { kind: turn.kind, body: `${KIND_LABEL.dispute}，等你裁定` };
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
