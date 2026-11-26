import type { RestartImpact } from "./reattach.js";
import { releaseRuntimeHandover, reserveRuntimeHandover, runtimeHandoverMatches } from "./runtime-handover-state.js";

type HeldTurn = { taskId: string; seq: number; token: string | null; role: string };

/**
 * `standing`：服务退出时会跟着收掉、又接不过去的东西（终端会话、项目服务、预览试跑……，见 shutdown-resources.ts）。
 * Windows 桌面版换运行时传它：这些要留在旧服务上等它们结束，不能借一次切换把它们关掉。封口之后才问 —— 那时新请求
 * 已经进不来，问到的就是停服前的最后一份；mac 不传，行为不变。
 */
export async function acquireRuntimeHandover(assess: () => Promise<RestartImpact>, held: () => HeldTurn[],
  preparation?: { seal(lease: string): Promise<void>; checkpoint(impact: RestartImpact, lease: string): Promise<void> },
  standing?: () => Promise<string[]>) {
  const preview = await assess();
  if (preview.interrupted.length || preview.resumes.length || preview.runtimeHandover?.blocked.length) {
    return { error: preview.runtimeHandover?.blocked.map((item) => `${item.title}：${item.reason}`).join("；")
      || "旧服务继续运行，稍后再接管" };
  }
  const lease = reserveRuntimeHandover();
  if (!lease) return { error: "另一处正在接管服务" };
  let keep = false;
  try {
    const before = new Map(held().map((turn) => [turn.taskId, turn.seq]));
    await preparation?.seal(lease);
    const impact = await assess();
    if (impact.interrupted.length || impact.resumes.length) return { error: "旧服务继续运行，稍后再接管" };
    await preparation?.checkpoint(impact, lease);
    const final = preparation ? await assess() : impact;
    if (final.interrupted.length || final.resumes.length || final.runtimeHandover?.blocked.length
      || final.survives.length !== impact.survives.length || final.survives.some((task) => !impact.survives.some((old) => old.id === task.id && old.pid === task.pid))) {
      return { error: "准备期间任务状态变化，未停止服务" };
    }
    const resources = standing ? await standing() : [];
    if (resources.length) return { error: `仍在使用：${resources.join("；")}`, standing: resources };
    const survivors = new Set(impact.survives.map((task) => task.id));
    if (!runtimeHandoverMatches(lease) || held().some((turn) => !survivors.has(turn.taskId) || !turn.token
      || !["single", "reviewer"].includes(turn.role) || before.get(turn.taskId) !== turn.seq)) {
      return { error: "仍有任务正在起跑或结算，稍后再接管" };
    }
    keep = true;
    return { lease };
  } finally {
    if (!keep) releaseRuntimeHandover(lease);
  }
}

/** 强制切换时一项「会被打断的」：id 与 Windows 控制器摆给用户确认的那张名单同一套（desktop/windows/launcher/handover.mjs 的 blockersOf）。 */
export type ForcedItem = { id: string; title: string };

/**
 * 强制切换（Windows 桌面版：用户看过会打断谁，点了「现在切换」）。`accepted` 是他确认过的那几项的 id。
 * 跟无损交接一样先拿许可、封口（新请求进不来、新终端开不了），**封口之后**再看一遍会打断的：多出一个他没见过的
 * 就不发许可、当场解封，把这一份名单交回去重新问（widened）。确认过的那些照他的意思被打断，交给新服务按 pid 认回
 * 能认回的；**没在名单上的、能接管的会话一个都不放过检查点**：输出消费先停到检查点、正文和水位落了盘，再核一遍
 * 名单 —— 期间多出没确认过的、或者多出没到检查点的会话，同样不发。之后控制器兑现许可，旧服务自己退出，封口一直
 * 保持到它退出，查完名单到停下之间没有再接活的空当。
 */
export async function acquireForcedRuntimeHandover(assess: () => Promise<RestartImpact>, accepted: Set<string>,
  preparation: { seal(lease: string): Promise<void>; checkpoint(sessions: string[], lease: string): Promise<void> },
  standing: () => Promise<ForcedItem[]>): Promise<{ lease?: string; error?: string; widened?: ForcedItem[] }> {
  const lease = reserveRuntimeHandover();
  if (!lease) return { error: "另一处正在接管服务" };
  let keep = false;
  /** 这一刻会被打断的里面，用户没确认过的那几项；报不出会打断谁时是 null。 */
  const unconfirmed = async (impact: RestartImpact) => {
    if (!impact.runtimeHandover) return null;
    const items: ForcedItem[] = [
      ...impact.runtimeHandover.blocked.map((item) => ({ id: item.id, title: item.title })),
      ...await standing(),
    ];
    return items.filter((item) => !accepted.has(item.id));
  };
  const widened = (items: ForcedItem[]) => ({ error: `确认之后又多了会被打断的：${items.map((item) => item.title).join("；")}`, widened: items });
  try {
    await preparation.seal(lease);
    const impact = await assess();
    const before = await unconfirmed(impact);
    if (!before) return { error: "旧服务确认不了会打断谁" };
    if (before.length) return widened(before);
    const sessions = impact.runtimeHandover!.sessions;
    await preparation.checkpoint(sessions, lease);
    const final = await assess();
    const after = await unconfirmed(final);
    if (!after) return { error: "旧服务确认不了会打断谁" };
    if (after.length) return widened(after);
    if (final.runtimeHandover!.sessions.some((session) => !sessions.includes(session))) return { error: "准备期间任务状态变化，未停止服务" };
    if (!runtimeHandoverMatches(lease)) return { error: "接管许可已撤销，旧服务未停止" };
    keep = true;
    return { lease };
  } finally {
    if (!keep) releaseRuntimeHandover(lease);
  }
}
