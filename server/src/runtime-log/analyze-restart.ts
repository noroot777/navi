// 每一次服务启动，认出它的上一轮服务是怎么没的。
//
// 分两步，各管各的：
//   1. **上一轮是谁**（身份）：这次启动在锁里认出的上一轮（`server.start.previous.run`），或者同一份日志里的
//      前一条 `server.start` 的 runId。两条都没有，才退回「这次启动之前最近的一条退出记录」，明说是推测。
//   2. **它是怎么没的**（证据）：只有记录能说到的那一步才说。按证据强弱：
//      · 残留——这次启动看见上一轮的锁还在（`previous`），或者退出账本给那一轮记了残留：它没收完尾就没了。
//        同时还有退出意向（收到了信号、开始退出）就是「进了退出流程没走完」，残留压过意向，不说成正常停；
//      · 那一轮自己写下的退出记录：只说明它**走到了哪一步**（收到了哪个信号、走到了退出码多少的那一步），
//        再加上下一份启动时没看到它的锁（不说成它放掉了锁：退出记录写在释放之前）。它是进程自己写的，写完之后照样可能被强杀（复审第 1 轮实测：SIGTERM 收尾放完锁、
//        退出前一刻 SIGKILL）——最终怎么结束的，进程外没有记录就不下结论，也不替它猜是谁发的信号；
//      · 什么都没有：**就说不知道**。身份只能证明「是哪一轮」，证明不了它删过锁、走过退出流程——账本被清理、
//        锁被截坏、记录超出读取范围，都会是这个样子（第 2 轮审查实测：SIGKILL 之后截坏锁，旧版说成了正常删锁）。
// 一条上一轮的线索都没有就不算重启，但也不说成「全新启动」：可能只是更早的日志已经不在了。
import type { RuntimeLogRecord } from "@navi/shared/runtime-log";
import type { ExitSummary } from "./load.js";

export type RestartVerdict = {
  /** 上一轮停下的原因（一句话），按证据说到哪一步。 */
  how: string;
  /** 上一轮是怎么认出来的：锁里 / 日志里的身份、按时间推测、没有任何线索。 */
  basis: "identity" | "time" | "none";
  /**
   * 记录能证明到哪一步：`stop_requested` 收到停止信号、`exiting` 自己走到了退出，且下一份启动时都没看到残留的锁
   * （两者都只是进程自己记下的步骤，不是最终结局）；`unfinished` 进了退出流程但锁还留着；`vanished` 什么都没留下就没了；
   * `unknown` 没有记录能说明。
   */
  ending: "stop_requested" | "exiting" | "unfinished" | "vanished" | "unknown";
};

const t = (record: { at: string }) => Date.parse(record.at);
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
const GUESS_WINDOW_MS = 86_400_000;

type Previous = { run?: string | null; evidence?: string; silentMs?: number | null; kind?: string; signal?: string };
type Ending = Omit<RestartVerdict, "basis">;

// 措辞只分两段：「记到的」是记录里有的事实（注明是进程自己记的还是下一份启动时看到的）；「可能是」是常见的几种
// 情况，明说是可能。不把进程自己写的步骤说成最终结局，不把可能说成原因。

function unfinished(intent: { kind?: string; signal?: string } | null, silentMs: unknown): Ending {
  const silent = silentMs ? `，最后一次心跳之后静默了 ${secs(Number(silentMs))}` : "";
  const lock = `锁还留着（下一份服务启动时看到的）${silent}`;
  if (intent) {
    const what = intent.kind === "signal" ? `收到 ${intent.signal ?? "信号"}` : "开始退出";
    return { how: `上一份服务${what}（进程自己记的），但${lock}；可能是收尾途中被强杀，或者数据目录写不进去`, ending: "unfinished" };
  }
  return { how: `上一份服务没留下任何退出记录，${lock}；可能是被强杀（kill -9）、内存不够被系统结束，或者原生崩溃`, ending: "vanished" };
}

/**
 * 进程自己记下了一步、下一份启动时没看到它的锁：只说这两件看到的事。退出记录写在释放锁之前（singleton.ts），
 * 所以不说「它放掉了锁」；锁可能是它放的，也可能是被清理或者没读到。最终怎么结束的不下结论。
 */
function finished(exit: ExitSummary): Ending {
  const after = "，下一份服务启动时没看到它留下的锁；之后进程最终怎么结束的没有进程外的记录";
  if (exit.kind === "signal") {
    return { how: `上一份服务收到 ${exit.signal}（进程自己记的，运行了 ${secs(Number(exit.uptimeMs ?? 0))}）${after}`, ending: "stop_requested" };
  }
  return { how: `上一份服务走到了退出、退出码 ${exit.code ?? "?"}（进程自己记的）${after}`, ending: "exiting" };
}

/** 一条账本记录说明的结局。残留记录自己带着「当时看没看到退出意向」。 */
function fromLedger(exit: ExitSummary, intent: ExitSummary | undefined): Ending {
  if (exit.kind !== "residual") return finished(exit);
  const observed = intent ?? (exit.evidence === "exit_intent" ? (exit.observedIntent as { kind?: string; signal?: string } | undefined) ?? {} : null);
  return unfinished(observed ?? null, exit.silentMs);
}

const UNKNOWN: Ending = {
  how: "上一份服务没有退出记录，也没看到它残留的锁；怎么停的不知道（账本或锁文件可能被清理、截坏，或者记录超出了读取范围）",
  ending: "unknown",
};

/** 每条 `server.start` 对应的结论（一条不落，`basis: "none"` 的不算重启）。 */
export function restartVerdicts(records: RuntimeLogRecord[], exits: ExitSummary[]): Map<RuntimeLogRecord, RestartVerdict> {
  const out = new Map<RuntimeLogRecord, RestartVerdict>();
  const starts = records.filter((record) => record.ev === "server.start" && record.src === "server");
  starts.forEach((start, index) => {
    const previous = start.previous && typeof start.previous === "object" ? (start.previous as Previous) : null;
    const prior = starts[index - 1];
    const prevRun = previous?.run ?? (typeof prior?.run === "string" ? (prior.run as string) : null);

    // 这次启动自己看见了残留的锁：上一轮没收完尾，这是最直接的证据（锁里认不出是谁时身份也照样算——那就是上一个持锁的）。
    if (previous) {
      const intent = prevRun ? exits.find((exit) => exit.kind !== "residual" && exit.runId === prevRun) : undefined;
      const sawIntent = previous.evidence === "exit_intent" ? { kind: previous.kind, signal: previous.signal } : intent ?? null;
      out.set(start, { ...unfinished(sawIntent, previous.silentMs), basis: "identity" });
      return;
    }
    if (prevRun) {
      const mine = exits.filter((exit) => exit.runId
        ? exit.runId === prevRun
        // 老的残留记录没有 runId：认进程号，且得记在那一轮启动之后。
        : exit.kind === "residual" && prior !== undefined && exit.pid === prior.pid && t(exit) >= t(prior));
      const residual = mine.find((exit) => exit.kind === "residual");
      const intent = mine.find((exit) => exit.kind !== "residual");
      const ending = residual ? fromLedger(residual, intent) : intent ? finished(intent) : UNKNOWN;
      out.set(start, { ...ending, basis: "identity" });
      return;
    }
    // 上一轮不在这份日志里：退回按时间找最近的一条，并且明说是推测。
    const at = t(start);
    let guess: ExitSummary | undefined;
    for (const exit of exits) {
      if (t(exit) <= at && at - t(exit) < GUESS_WINDOW_MS && exit.runId !== start.run && (!guess || t(exit) >= t(guess))) guess = exit;
    }
    if (guess) {
      const intent = guess.kind === "residual" && guess.runId ? exits.find((exit) => exit.kind !== "residual" && exit.runId === guess!.runId) : undefined;
      const ending = fromLedger(guess, intent);
      out.set(start, { ...ending, how: `（按时间推测）${ending.how}`, basis: "time" });
      return;
    }
    out.set(start, {
      how: "查不到上一份服务的任何记录（日志从这里开始：更早的记录已经不在了，或者这是第一次启动）",
      basis: "none",
      ending: "unknown",
    });
  });
  return out;
}
