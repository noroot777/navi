import { randomUUID } from "node:crypto";

export class RuntimeHandoverBlockedError extends Error {
  constructor() {
    super("正在切换新版服务，完成后重试此操作");
    this.name = "RuntimeHandoverBlockedError";
  }
}

let lease: { token: string; deadline: number; committed?: true } | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const waiting = new Set<() => void>();

/** 许可兑现之后过多久退出：只留够把「兑现了」这句答复送出去。 */
export const COMMITTED_EXIT_MS = 300;

function endLease(): void {
  lease = null;
  if (expiry) clearTimeout(expiry);
  expiry = null;
  const callbacks = [...waiting];
  waiting.clear();
  for (const callback of callbacks) {
    try { callback(); } catch (error) { console.error("[navi] runtime handover waiter failed:", error); }
  }
}

export function runtimeHandoverActive(): boolean {
  if (lease && Date.now() >= lease.deadline) endLease();
  return lease !== null;
}

export function reserveRuntimeHandover(): string | null {
  if (runtimeHandoverActive()) return null;
  lease = { token: randomUUID(), deadline: Date.now() + 60_000 };
  expiry = setTimeout(endLease, 60_000);
  expiry.unref();
  return lease.token;
}

export function releaseRuntimeHandover(token: string): boolean {
  if (!lease || lease.token !== token || lease.committed) return false;
  endLease();
  return true;
}

/**
 * 兑现许可 = 这份服务自己下线，交给接管方起新版。核验许可和退出是这份服务里同一步做的：要是先回一句「有效」、再由
 * 接管方来停，中间许可可能刚好到期、服务解封接了新活，接管方却照着旧答复把它连同新活一起停掉；兑现后要是还留着
 * 「封着等人来停」这个状态，接管方中途没了，它要么一直封着，要么到点没人接续地退出。所以兑现后不再到期、不能撤回
 * （release 认不了它），`exitAfterMs` 后按 `exit` 退出。起新版是接管方的事：它在许可之前就准备好了新版、核过了影响，
 * 窗口那边退出时也会先把这一趟做完（desktop/windows/launcher/controller-main.mjs）。
 */
export function commitRuntimeHandover(token: string, exit: () => void, exitAfterMs = COMMITTED_EXIT_MS): boolean {
  if (!runtimeHandoverMatches(token) || !lease) return false;
  if (!lease.committed) {
    if (expiry) clearTimeout(expiry);
    lease.deadline = Infinity;
    lease.committed = true;
    expiry = setTimeout(exit, exitAfterMs);
  }
  return true;
}

/**
 * 这张许可（还没兑现时）最晚兑现到什么时刻（Date.now 的毫秒数）。过了它，晚到的兑现一律被拒 —— 接管方据此断定一个
 * 没收到答复的兑现「没执行、以后也不会执行」，不用拿本机计时去猜。兑现后是 Infinity，没有许可是 null。
 */
export function runtimeHandoverDeadline(token: string): number | null {
  return lease && lease.token === token ? lease.deadline : null;
}

export function runtimeHandoverMatches(token: string): boolean {
  return runtimeHandoverActive() && lease?.token === token;
}

export function afterRuntimeHandover(callback: () => void): () => void {
  if (!runtimeHandoverActive()) { callback(); return () => {}; }
  waiting.add(callback);
  return () => { waiting.delete(callback); };
}
