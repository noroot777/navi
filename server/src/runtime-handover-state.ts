import { randomUUID } from "node:crypto";

export class RuntimeHandoverBlockedError extends Error {
  constructor() {
    super("正在切换新版服务，完成后重试此操作");
    this.name = "RuntimeHandoverBlockedError";
  }
}

let lease: { token: string; deadline: number } | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const waiting = new Set<() => void>();

/** 许可兑现之后，接管方没来停这份服务时自己退出的期限（接管方停服只要几秒；它中途崩了也不让服务一直封着）。 */
export const COMMITTED_EXIT_MS = 90_000;

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
  if (!lease || lease.token !== token) return false;
  endLease();
  return true;
}

/**
 * 兑现许可：接管方马上就要停这份服务了。核验和「不再到期」在同一步里做 —— 先查有效、再去停，中间许可可能刚好到期、
 * 服务解封接了新活，接管方却照着旧答复把它连同新活一起停掉。兑现后封口一直保持到退出：不再自动到期；接管方停服失败
 * 时 release 照常解封；接管方自己没了，到 `COMMITTED_EXIT_MS` 由这份服务按 `exit` 自己退出（它本来就要被停）。
 */
export function commitRuntimeHandover(token: string, exit: () => void, exitAfterMs = COMMITTED_EXIT_MS): boolean {
  if (!runtimeHandoverMatches(token) || !lease) return false;
  if (lease.deadline !== Infinity) {
    if (expiry) clearTimeout(expiry);
    lease.deadline = Infinity;
    expiry = setTimeout(exit, exitAfterMs);
  }
  return true;
}

export function runtimeHandoverMatches(token: string): boolean {
  return runtimeHandoverActive() && lease?.token === token;
}

export function afterRuntimeHandover(callback: () => void): () => void {
  if (!runtimeHandoverActive()) { callback(); return () => {}; }
  waiting.add(callback);
  return () => { waiting.delete(callback); };
}
