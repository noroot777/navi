import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPlanImplementation, isPlanToggle, PLAN_IMPLEMENT_LABEL, type CliCommand } from "@navi/shared/cli-commands";
import { RUNS_DIR } from "./paths.js";
import { assertPlanReady } from "./task-plan.js";

/** `/plan implement` 换进 prompt 的那句（codex 那一路在 executors/codex-native-commands.ts 里接在原文后面）。 */
export const PLAN_IMPLEMENT_TEXT = "用户已确认最新计划，现在按此计划开始实施。";

/**
 * 实施回合交给模型的正文：用户批准的那张卡的原文。卡是交计划那一刻的快照，计划文件之后被改过也以
 * 卡上这份为准（executors/claude-plan-gate.ts）。
 */
export const planImplementText = (approved: string, snapshot?: string) =>
  `用户已确认下面这份计划，现在按它开始实施。以这份原文为准：计划文件在交出之后若被改过，不按改过的做。\n\n<approved-plan>\n${approved}\n</approved-plan>`
  + (snapshot ? `\n\n${PLAN_COPY_HINT(snapshot)}` : "");

/**
 * 卡上原文另存的那份文件在哪、什么时候该用它。模型没有「复制」这个动作，经它的手写出来的每个字都是
 * 当场重新输出的：计划本身就是要交的那份文档时，整篇逐字重写一遍要好几分钟（qfix1xZNymhT 的
 * 1.5 万字方案就是这么写的，中途一被打断又从头来）。给它一个文件，复制再改只要几秒。
 */
export const PLAN_COPY_HINT = (snapshot: string) =>
  `这份计划原文也逐字存成了文件：\`${snapshot}\`。要产出的文件和计划大段相同时（比如把计划落成一份文档），先把这个文件复制过去、再改不一样的地方，别把整篇逐字重写一遍——长文件逐字输出要好几分钟。`;

/**
 * 把用户批准的那张卡原样落一份文件，放在任务自己的运行目录里（不进仓库、不在工作区里）。claude 的
 * 计划文件交出之后还可能被改，codex 的计划压根只在会话里，所以两家都落这一份，内容就是卡上原文。
 */
export async function savePlanSnapshot(taskId: string, plan: { id: string; text: string }): Promise<string> {
  const dir = join(RUNS_DIR, taskId, "plans");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${plan.id.replace(/[^\w-]+/g, "_")}.md`);
  await writeFile(path, `${plan.text}\n`);
  return path;
}

/**
 * 这句话交给模型的正文，以及它是不是「带着问题进计划回合」。
 *
 * codex 的 `/plan` 是原生命令，原文交给 app-server 的协作模式去认（codex-native-commands.ts）。
 * claude 在 headless 下没有可透传的 `/plan`（2.1.283 的 init `slash_commands` 里没有它），计划模式
 * 只能由 Navi 起跑时切权限参数（executors/claude-plan-gate.ts），所以前缀在这里摘掉：
 * `/plan 问题` → 计划回合里的「问题」；`/plan implement` → 让它按刚批准的计划动手，`approved` 是那张卡的
 * 原文（调用方经 task-plan.ts `assertPlanReady` 取出；没给只会出现在马上要被拒的起跑里）。
 * 裸 `/plan`、`/plan off` 不起进程（`isPlanToggle`）：回复框里在 task-cli-command.ts 当场改状态，
 * 起智能体的入口（首次运行、重试、队列推进）在 prepareCliInvocation 一律拒掉。
 * `shown` = 会话气泡里记的那句话，跟交给模型的 `text` 不同时才给（`PLAN_IMPLEMENT_LABEL`，理由在它的定义上）。
 */
export function planTurnInput(
  agent: string,
  slash: CliCommand | null,
  userText: string,
  approved?: { text?: string; snapshot?: string },
): { question: boolean; text: string; shown?: string } {
  if (slash?.name !== "plan") return { question: false, text: userText };
  if (isPlanImplementation(slash)) {
    // codex 的计划在它自己的会话里，原文不必再贴一遍（「按计划实施」那句由 codex-native-commands.ts
    // 接在后面）；另存的那份文件两家都给。
    const snapshot = approved?.snapshot;
    const text = agent !== "claude"
      ? snapshot ? `${userText}\n\n${PLAN_COPY_HINT(snapshot)}` : userText
      : approved?.text ? planImplementText(approved.text, snapshot) : PLAN_IMPLEMENT_TEXT;
    return { question: false, text, shown: PLAN_IMPLEMENT_LABEL };
  }
  if (agent !== "claude" || isPlanToggle(agent, slash)) return { question: false, text: userText };
  return { question: true, text: slash.args };
}

/**
 * 续聊回合用：`/plan implement` 先取出用户批准的那张卡（同时就是「能不能实施」的预检），再按卡上原文
 * 拼实施正文；其余同 `planTurnInput`。
 */
export async function resolvePlanTurn(taskId: string, agent: string, slash: CliCommand | null, userText: string, profileId: string | null, ownerId: string | null): Promise<ReturnType<typeof planTurnInput>> {
  if (!isPlanImplementation(slash)) return planTurnInput(agent, slash, userText);
  // claude 要卡上原文才实施得了，取不到就拒；codex 照旧原样透传，取不到只是少一份文件。
  const card = await assertPlanReady(taskId, agent, profileId, ownerId, slash!.args.split(/\s+/)[1])
    .catch((error: unknown) => { if (agent === "claude") throw error; return null; });
  const snapshot = card ? await savePlanSnapshot(taskId, card).catch((error: unknown) => {
    console.warn(`[navi] 任务 ${taskId} 的计划原文没能另存成文件，这次实施不提示复制:`, error);
    return undefined;
  }) : undefined;
  return planTurnInput(agent, slash, userText, card ? { text: card.text, snapshot } : undefined);
}
