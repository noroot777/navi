// 系统通知的「此刻账上该是什么样」（system-notify.ts 拿它跟账上记的上一次比）。
//
// 每一样都是一件事**自己的**身份，跟此刻是不是正好停在那一步无关，所以不在那一步时也照记：
//   seen           见过这个任务（此刻没事要人管的任务账上也得有一行，之后它再有什么都不是历史）
//   accept         这一版成果：完成过几次 + 停在哪一道「等我点头」+ 最近一次审查的结论。「完成过几次」只数真完成：
//                  单飞、讨论是 tasks.done_seq（只有 completion 才加）；团队调度台是共享执行者各自的 done_seq 加上调度台
//                  最近一个**正常收口**的回合 —— 不用 task-result-version.ts 的「最近一个回合的开始时刻」，那连挂掉、被停的
//                  回合也算成新的一版（第 3 轮审查 1）。
//                  只在此刻正等验收时说话（说法跟着审查结论走：完成了 / 审查通过 / 审查没通过），账也只在那时、或者头一回
//                  见到这个任务时记：完成之后还要先验证、先审、托盘里的消息先送进去，那几步里身份已经是新的，等它真停到
//                  等验收上才说，跟上一次说过的比。
//                  不认结束时刻：续聊挂了、被停了，结算把原来的 done 放回去，结束时刻也跟着刷新（status.ts），那不是新的一版。
//                  也不能只在等验收时才记：先看到的是续聊在跑，之后放回原 done，那不是新的完成（第 2 轮审查 1.1.1 复发）。
//   verify         验证没过那一版：完成过几次 + 跑完过几轮验证。同一版重新验证又没过也是新的一回。记账时机同 accept。
//   turn:<种类>    其余几种「下一步」（提问、失败、待裁定、讨论闸口）上次见到的是哪一回，代次同 im/attention.ts。
//   interrupt      最近一个回合（单飞会话、团队调度台）挂了、任务却没落失败（续聊挂了，原来的结果还在；调度台挂了回到待命）：
//                  那一回合。落了失败的由 turn:failed 说。
//   stop           被停下的那一次：认那个被停的回合自己（session_turns.outcome = stopped；续聊被停、原来的状态放回去，分组暂停，
//                  调度台被停回到待命，跑着被停落 canceled 都是它）；没有被停的回合（排着就被取消了）才认 canceled 那一下的落位。
//                  同一次停止只记一样，不重复说。
//   reviewed       最近一条工作区审查链的最终结论（通过 / 没通过，链收口了才有）。审查结论是它自己的事，不看任务此刻停在哪：
//                  暂停着、失败着的任务上派的审，最后一轮没过也得说（第 5 轮审查 1）。此刻正等验收时由 accept 说（它的身份里
//                  带着这个结论，措辞是「审查没通过，等你决定」），这里只记账，不说第二遍。
//   result/gate/review  结局账，同 im/outcomes.ts。review 那一样只记账（候选查找 staleOutcomeTasks 按它对账），话由 reviewed 说。
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
import { isSharedTeamWorker } from "./task-result-version.js";

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
  /** 最近一个回合（单飞会话、团队调度台）。 */
  lastTurn: { id: string; outcome: string | null } | null;
  /** 真完成过几次（见文件头 accept）。 */
  completions: string;
}

/** 算「最近一个回合」时认的会话：任务自己干活的那条（审查者、讨论双方各自的会话不算）。 */
const OWN_ROLES = ["single", "lead"];

export async function factsOf(taskIds: string[]): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  if (!taskIds.length) return out;
  const rows = await db.select({
    id: tasks.id, mode: tasks.mode, parentId: tasks.parentId, doneSeq: tasks.doneSeq, verifyRounds: tasks.verifyRounds, humanGateId: tasks.humanGateId,
  }).from(tasks).where(inArray(tasks.id, taskIds));
  for (const row of rows) {
    const [turn, review, completions] = await Promise.all([
      db.select({ id: sessionTurns.id, outcome: sessionTurns.outcome }).from(sessionTurns)
        .innerJoin(sessions, and(eq(sessions.id, sessionTurns.sessionId), inArray(sessions.role, OWN_ROLES)))
        .where(eq(sessionTurns.taskId, row.id)).orderBy(desc(sessionTurns.startedAt)).limit(1),
      db.select({ id: freeReviewRuns.id, status: freeReviewRuns.status, finishedAt: freeReviewRuns.finishedAt }).from(freeReviewRuns)
        .where(and(eq(freeReviewRuns.taskId, row.id), eq(freeReviewRuns.targetKind, "workspace")))
        .orderBy(desc(freeReviewRuns.createdAt)).limit(1),
      row.mode === "team" && !row.parentId ? teamCompletions(row.id) : Promise.resolve(`done#${row.doneSeq}`),
    ]);
    const latest = review.at(0);
    out.set(row.id, {
      doneSeq: row.doneSeq,
      verifyRounds: row.verifyRounds,
      humanGate: humanGateOf(row),
      review: latest ? { id: latest.id, status: latest.status, finished: !!latest.finishedAt } : null,
      lastTurn: turn.at(0) ?? null,
      completions,
    });
  }
  return out;
}

/** 团队调度台真完成过几次：共享执行者各自完成过几次，加上调度台最近一个正常收口的回合。 */
async function teamCompletions(leadId: string): Promise<string> {
  const [crew, lead] = await Promise.all([
    db.select({ id: tasks.id, doneSeq: tasks.doneSeq, useWorktree: tasks.useWorktree }).from(tasks).where(eq(tasks.parentId, leadId)),
    db.select({ id: sessionTurns.id }).from(sessionTurns)
      .innerJoin(sessions, and(eq(sessions.id, sessionTurns.sessionId), eq(sessions.role, "lead")))
      .where(and(eq(sessionTurns.taskId, leadId), eq(sessionTurns.outcome, "completed")))
      .orderBy(desc(sessionTurns.startedAt)).limit(1),
  ]);
  const shared = crew.filter(isSharedTeamWorker).map((worker) => `${worker.id}#${worker.doneSeq}`).sort();
  return `team:${shared.join(",")}|lead:${lead.at(0)?.id ?? "-"}`;
}

/** 这一版成果的身份（见文件头 accept）。 */
function acceptIdentity(facts: Facts): string {
  const result = facts.completions;
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
      kind: "accept", value: acceptIdentity(facts), whenSaid: true,
      said: turn?.kind === "accept" ? { kind: "accept", body: acceptSubtitle(turn) } : null,
    },
    {
      kind: "verify", value: `${facts.completions}|v#${facts.verifyRounds}`, whenSaid: true,
      said: turn?.kind === "verify_failed" ? { kind: "verify_failed", body: KIND_LABEL.verify_failed } : null,
    },
  ];
  // 还在跑（或刚收口、还没结算）的不看：结局还没定。
  const settled = task.status !== "running" && task.status !== "queued";
  const last = settled ? facts.lastTurn : null;
  if (turn && turn.kind !== "accept" && turn.kind !== "verify_failed") {
    // 失败任务上的续聊被停了：放回去的是原来那次失败（结束时刻刷新了，代次跟着变），这一下是「停了」，下面 stop 说
    const restored = turn.kind === "failed" && last?.outcome === "stopped";
    entries.push({ kind: `turn:${turn.kind}`, value: turn.generation, said: restored ? null : turnWords(view, turn) });
  }
  if (last?.outcome === "failed") {
    const settledAsFailure = task.status === "failed" || task.status === "canceled";
    entries.push({
      kind: "interrupt", value: last.id,
      said: settledAsFailure ? null : { kind: "interrupted", body: task.status === "done" ? "这一轮中断了，结果还是上一版" : "这一轮中断了" },
    });
  }
  const stopped = { kind: "stopped" as const, body: task.status === "paused" ? "已暂停" : "已停止" };
  // 认那个被停的回合；没有（排着就被取消了）才认 canceled 那一下的落位。先认落位的话，停完又重新排上、还没开新回合时
  // 身份就从落位换成了回合，同一次停止说两遍。
  if (last?.outcome === "stopped") entries.push({ kind: "stop", value: `turn:${last.id}`, said: stopped });
  else if (task.status === "canceled") entries.push({ kind: "stop", value: `canceled:${task.endedAt ?? task.updatedAt}`, said: stopped });
  // 审查链收口了：任务还在跑（收口之后马上又开了一轮）先不看，落定了再说
  if (settled && facts.review?.finished) {
    const passed = facts.review.status === "passed";
    entries.push({
      kind: "reviewed", value: `${facts.review.id}:${facts.review.status}`,
      said: turn?.kind === "accept" ? null : passed ? { kind: "review_passed", body: "审查通过" } : { kind: "review_failed", body: "审查没通过" },
    });
  }
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
  return null;
}
