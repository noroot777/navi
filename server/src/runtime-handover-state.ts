import { randomUUID } from "node:crypto";

// 「先别接新活」的那把许可：同一时刻只有一份，有自己的期限，持有者不续也不放，到点自己解冻。
//
// 两种用途共用这一份，冻结的东西一样（新回合认领、新终端、新 agent 拉起……见各入口的
// `serviceFrozen()` / `waitServiceThaw()`），区别只在冻结之外还做什么：
//  · handover  mac 换运行时（runtime-handover-*.ts）：另外封住整个 /api（runtime-handover-gate.ts），
//              旧服务要把在途请求和输出通道都交给新服务
//  · restart   准备重启（restart-freeze.ts）：接口照常应答，只是不再起会被这次重启打断的新东西，
//              好让给出去的影响快照在停服务之前一直算数
// 被挡住的入口一律**等**，不算失败：许可一放（用户取消、期限到了）它们原样接着走。
//
// 另有一种不是许可的冻结：**正在停止**（beginServiceShutdown，singleton.ts 收到停止信号那一刻）。它不可撤销、
// 没有期限：退出过程中别处放掉许可、许可到期都不会让入口接着走 —— 不然排空收掉的是开始时那几个，后来放进来的
// 新智能体就留在退出之后没人管了。被它挡住的入口一直等到进程退出。

export type ServiceFreezeKind = "handover" | "restart";

export class ServiceFrozenError extends Error {
  constructor() {
    super(`${serviceFrozenText()}，完成后重试此操作`);
    this.name = "ServiceFrozenError";
  }
}

type Lease = { token: string; kind: ServiceFreezeKind; deadline: number; revision: number };

let lease: Lease | null = null;
let shuttingDown = false;
let expiry: ReturnType<typeof setTimeout> | null = null;
let revisions = 0;
const waiting = new Set<() => void>();
const changes = new Set<() => void>();

function arm(ttlMs: number): void {
  if (!lease) return;
  if (expiry) clearTimeout(expiry);
  lease.deadline = Date.now() + ttlMs;
  expiry = setTimeout(endLease, ttlMs);
  expiry.unref();
}

function notify(): void {
  for (const change of changes) {
    try { change(); } catch (error) { console.error("[navi] service freeze listener failed:", error); }
  }
}

function endLease(): void {
  lease = null;
  if (expiry) clearTimeout(expiry);
  expiry = null;
  notify();
  if (shuttingDown) return; // 正在停止：许可没了也不放行，等着的留到进程退出
  const callbacks = [...waiting];
  waiting.clear();
  for (const callback of callbacks) {
    try { callback(); } catch (error) { console.error("[navi] service freeze waiter failed:", error); }
  }
}

/** 此刻的冻结（到点的当场作废）。 */
export function currentServiceFreeze(): Readonly<Lease> | null {
  if (lease && Date.now() >= lease.deadline) endLease();
  return lease;
}

export function serviceFrozen(): boolean {
  return currentServiceFreeze() !== null || shuttingDown;
}

/** 服务开始停止：从此不再接活，不可撤销（见顶部）。 */
export function beginServiceShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  notify();
}

export function serviceShuttingDown(): boolean {
  return shuttingDown;
}

/** 被挡住的入口怎么跟人说。 */
export function serviceFrozenText(): string {
  if (shuttingDown) return "服务正在停止";
  return currentServiceFreeze()?.kind === "restart" ? "服务正在准备重启" : "正在切换新版服务";
}

/** 拿一份冻结；已经有人拿着就是 null。`revision` 每拿一次加一，快照凭它认是哪一次冻结。 */
export function reserveServiceFreeze(kind: ServiceFreezeKind, ttlMs: number): { token: string; deadline: number; revision: number } | null {
  if (serviceFrozen()) return null;
  lease = { token: randomUUID(), kind, deadline: 0, revision: ++revisions };
  arm(ttlMs);
  notify();
  return { token: lease.token, deadline: lease.deadline, revision: lease.revision };
}

/** 持有者续期；凭据对不上（已放、已过期、换了一份）就是 null。 */
export function renewServiceFreeze(token: string, ttlMs: number): number | null {
  if (!serviceFreezeMatches(token)) return null;
  arm(ttlMs);
  notify();
  return lease!.deadline;
}

export function releaseServiceFreeze(token: string): boolean {
  if (!lease || lease.token !== token) return false;
  endLease();
  return true;
}

export function serviceFreezeMatches(token: string): boolean {
  return currentServiceFreeze()?.token === token;
}

/** 冻结一结束就调；此刻没冻结就当场调。交回撤销函数。 */
export function afterServiceFreeze(callback: () => void): () => void {
  if (!serviceFrozen()) { callback(); return () => {}; }
  waiting.add(callback);
  return () => { waiting.delete(callback); };
}

/**
 * 等到没冻结为止。会产生新的重启影响的入口在登记自己之前等它；等完到登记之间要是隔着 await，
 * 那条缝里可能又冻上，快照就漏了它。
 *
 * 给了 `canceled` 就边等边看：等着的时候用户取消了，交回 false，调用方别再往下起（冻结可能要等好一阵，
 * 解冻之后才发现「早就取消了」时，东西已经起起来了）。没冻着时也先看一眼。
 */
export async function waitServiceThaw(canceled?: () => boolean): Promise<boolean> {
  while (serviceFrozen()) {
    if (canceled?.()) return false;
    await new Promise<void>((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      let off = () => {};
      const done = () => { if (poll) clearInterval(poll); off(); resolve(); };
      off = afterServiceFreeze(done);
      if (canceled) poll = setInterval(() => { if (canceled()) done(); }, 200);
    });
  }
  return !canceled?.();
}

/** 冻结开始、续期、结束时调（界面上那句「服务正在准备重启」靠它推送）。 */
export function onServiceFreezeChange(listener: () => void): () => void {
  changes.add(listener);
  return () => { changes.delete(listener); };
}

// ── 换运行时那一种（runtime-handover-*.ts 与它的回归直接用这几个名字）────────────────
const HANDOVER_TTL_MS = 60_000;

export function runtimeHandoverActive(): boolean {
  return currentServiceFreeze()?.kind === "handover";
}

export function reserveRuntimeHandover(): string | null {
  return reserveServiceFreeze("handover", HANDOVER_TTL_MS)?.token ?? null;
}

export function releaseRuntimeHandover(token: string): boolean {
  return releaseServiceFreeze(token);
}

export function runtimeHandoverMatches(token: string): boolean {
  return runtimeHandoverActive() && serviceFreezeMatches(token);
}

export const afterRuntimeHandover = afterServiceFreeze;
