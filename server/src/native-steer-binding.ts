// 单飞会话接「原生引导」的那一份接线：原话送进 CLI 之前补上技能调用，送达之后在会话里记成一条
// 真人记录。首跑（task-run.ts）、续聊（orchestrator.ts）、重启接回（reattach.ts）三个起跑入口共用。
import type { AgentType, SessionRole } from "@navi/shared";
import { recordUserConversationTurn } from "./conversation-turn.js";
import type { SingleRunArgs } from "./single-run.js";
import { withSkillInvocation } from "./skills.js";

export function nativeSteerBinding(input: {
  taskId: string;
  sessionId: string;
  role: SessionRole;
  agentType: AgentType;
  cwd: string;
  userId?: string | null;
  out: NodeJS.WritableStream;
  /** 这一轮是计划模式回合（runs.ts `planSteerTarget`）。重启接回时由执行器认（`RunHandle.planTurn`）。 */
  plan?: boolean;
}): NonNullable<SingleRunArgs["nativeSteer"]> {
  const { taskId, sessionId, role, agentType, cwd, userId, out } = input;
  return {
    prepare: (text) => withSkillInvocation({ agentType, cwd, text, userId }),
    record: (text, at) => recordUserConversationTurn({ taskId, sessionId, role, agentType, out, text, at }),
    plan: input.plan,
  };
}
