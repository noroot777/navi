// 「引导会话」此刻能不能成 —— 不碰任何状态的那几条前置条件。`steerQueuedMessage`(task-steer.ts)
// 按它拒,排队消息接口(pending-wait.ts)按它决定托盘上出不出那颗键:两边一份判据,托盘才不会
// 给出一颗点了必然 409 的键(任务早停了,托盘还亮着「引导会话」,点下去是「当前回合已经结束」)。
//
// 判据外只剩撞车那一类:原生引导正在启动、回合恰好在提交前结束、租约被别的投递抢走 —— 那些
// 只有真去做才知道,照旧由 steerQueuedMessage 当场拒并说明。
import type { AgentType } from "@navi/shared";
import { parseCliCommand } from "@navi/shared/cli-commands";
import type { scheduledMessages, tasks } from "./db/schema.js";
import { isCanceling, planSteerTarget, turnRole } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { nativeCliCommand } from "./skills.js";
import { isUserAuthoredMessage } from "@navi/shared/scheduled-message-author";

type MessageRow = typeof scheduledMessages.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export type SteerRefusal = {
  status: 404 | 409;
  error: string;
  /** 这一条拒绝要记进任务时间线(停止/暂停与引导撞上,用户事后要看得到)。 */
  record?: true;
};

function sideTurnReason(task: TaskRow, planTurn: boolean): string | null {
  if (task.verifyRound != null) return "当前正在进行验证回合，消息继续排队";
  if (task.reviewOf) return "当前是审查任务回合，消息继续排队";
  // 计划回合在库里同样记 native_turn、运行时身份是旁路，只为不按任务执行结算；它本身是同一条
  // 会话里的普通对话，原话照样能插进去（runs.ts `planSteerTarget`）。
  if (planTurn) return null;
  if (task.nativeTurn) return "当前正在执行 CLI 命令，消息继续排队";
  const role = turnRole(task.id);
  if (role && role !== "single") return "当前是审查或系统旁路回合，消息继续排队";
  return null;
}

/**
 * `firstUserQueuedId` = 这个任务上排得最早的那条用户自己写的 queued 消息(排序同托盘:
 * sendAt、createdAt、id)。由调用方查好传进来:路由查一次,托盘那边整张表手上就有。
 */
export function steerRefusal(message: MessageRow, task: TaskRow | null, firstUserQueuedId: string | undefined): SteerRefusal | null {
  if (message.status !== "pending" || message.mode !== "queued") {
    return { status: 409, error: "只有仍在排队的消息可以引导会话" };
  }
  if (!task) return { status: 404, error: "任务不存在" };
  if (task.mode !== "single") return { status: 409, error: "只有单飞任务支持引导会话" };
  if (task.archived) return { status: 409, error: "任务已归档，消息继续保留在排队中" };
  if (task.status !== "running" && task.status !== "queued") {
    return { status: 409, error: "当前回合已经结束，消息会按排队顺序自动发送" };
  }
  const plan = planSteerTarget(task.id);
  const blocked = sideTurnReason(task, !!plan);
  if (blocked) return { status: 409, error: blocked };
  if (isCanceling(task.id)) return { status: 409, error: "任务正在停止或所在分组正在暂停，消息继续排队", record: true };
  if (isAcceptingTask(task.id)) return { status: 409, error: "任务正在验收，引导未执行，消息继续排队" };
  // 队首只在用户自己写的消息里排：排在前面的哨兵唤醒、审查交接不拦用户插话，它们等引导
  // 出来的那一轮结束后照常投递；用户自己的几句话之间仍不许反序。
  if (!isUserAuthoredMessage(message)) {
    return { status: 409, error: "只有你自己发的消息可以引导会话，这条会按排队顺序自动发送" };
  }
  if (firstUserQueuedId !== message.id) return { status: 409, error: "只能按排队顺序引导你最早的一条消息" };
  if (message.deliveringSince) return { status: 409, error: "消息正在投递或已被处理，请稍后查看" };
  // 计划回合只走原生引导：硬切再续跑那条路按「执行回合被打断」记账，旁路回合对不上。
  if (plan && !nativeMessageCanSteer(message, plan.agentType)) {
    return { status: 409, error: "这条要换执行器、模型或是一条 CLI 命令，插不进计划模式这一轮，会等它结束后发送" };
  }
  return null;
}

/**
 * 这条消息能不能原话插进正在跑的回合（原生引导）。不能的在普通回合里退回硬切再续跑。
 */
export function nativeMessageCanSteer(message: MessageRow, agentType: AgentType): boolean {
  // 余下几条是真的做不到，不是保守：换执行器/模型/思考强度都得换进程才生效；审查链的答复
  // 不归这条会话；CLI 原生命令要由 CLI 在一个新回合里自己解析。
  return steerAttachments(message) !== null
    && !message.agent
    && !message.executorId
    && !message.model
    && !message.reasoningEffort
    && !message.sessionRole
    && !nativeCliCommand(agentType, message.text)
    // `/plan …` 要换权限模式或开新回合（plan-turn.ts），插进正在跑的回合里只会变成一句普通话。
    && parseCliCommand(agentType, message.text)?.name !== "plan";
}

/**
 * 附件在 navi 里就是一段文本：`attachmentsPrompt` 把绝对路径清单拼进 prompt，agent 自己
 * 去 Read。原生引导送的也是同一条文本通道（claude 写一行 user 消息、codex 走 turn/steer），
 * CLI 一侧看不出「这句话带没带附件」，所以带附件不构成降级成 kill + resume 的理由。
 * 只有 attachments 列本身解析不出路径时才退回硬切 —— 那时原生送过去等于把附件丢了。
 */
export function steerAttachments(message: MessageRow): string[] | null {
  try {
    const parsed: unknown = JSON.parse(message.attachments);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return null;
    return parsed as string[];
  } catch { return null; }
}
