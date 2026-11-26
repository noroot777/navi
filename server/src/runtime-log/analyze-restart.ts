// 每一次服务启动，认出它的上一轮服务是怎么没的。
//
// **按身份对，不按时间凑**（第 1 轮审查：先正常重启一次、几分钟后服务突然消失，旧版按「十分钟内最近
// 一条退出」去凑，把后一次的异常消失说成了有人主动停的）。能证明身份的线索有两条：
//   · 这次启动自己发现了上一轮的残留锁（`server.start.previous`，锁里带着上一轮的 runId）——
//     上一轮没收完尾，账本里有没有它的退出意向决定是「被强杀/崩溃」还是「进了退出流程没走完」；
//   · 同一份日志里的前一条 `server.start` 带着上一轮的 runId，拿它去退出账本里找那一轮自己写的记录。
// 两条都没有（日志是这次窗口截断的、或者服务是加日志之前起的），才退回「这次启动之前最近的一条退出」，
// 而且明说是**按时间推测**的。一条退出也找不到就当全新启动，不算重启。
import type { RuntimeLogRecord } from "@navi/shared/runtime-log";
import type { ExitSummary } from "./load.js";

export type RestartVerdict = {
  /** 上一轮停下的原因（一句话）。 */
  how: string;
  /** 是按身份对上的（true），还是按时间推测的（false）。 */
  linked: boolean;
  /** 异常消失（没收完尾）。 */
  abnormal: boolean;
};

const t = (record: { at: string }) => Date.parse(record.at);
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
const GUESS_WINDOW_MS = 86_400_000;

type Previous = { run?: string | null; evidence?: string; silentMs?: number | null; kind?: string; signal?: string };

function describeResidual(previous: Previous): string {
  const silent = previous.silentMs ? `，最后一次心跳之后静默 ${secs(Number(previous.silentMs))}` : "";
  if (previous.evidence === "exit_intent") {
    const intent = previous.kind === "signal" ? `收到 ${previous.signal ?? "信号"}` : "开始退出";
    return `上一份服务${intent}、进了退出流程，但没收完尾（锁还留着）${silent}——收尾途中被强杀，或者数据目录写不进去`;
  }
  return `上一份服务没留下任何退出记录就没了${silent}——被强杀（kill -9）、系统内存不够被结束，或原生崩溃`;
}

function describeExit(exit: ExitSummary): string {
  if (exit.kind === "signal") {
    return `上一份服务收到 ${exit.signal} 退出（运行了 ${secs(Number(exit.uptimeMs ?? 0))}）——有人让它停的：升级、npm run restart、装更新或关机`;
  }
  return `上一份服务自己退出了（退出码 ${exit.code ?? "?"}）`;
}

/** 每条 `server.start` 对应的结论；全新启动（找不到任何上一轮）不在表里。 */
export function restartVerdicts(records: RuntimeLogRecord[], exits: ExitSummary[]): Map<RuntimeLogRecord, RestartVerdict> {
  const out = new Map<RuntimeLogRecord, RestartVerdict>();
  const starts = records.filter((record) => record.ev === "server.start" && record.src === "server");
  const finished = exits.filter((exit) => exit.kind !== "residual");
  starts.forEach((start, index) => {
    const previous = start.previous && typeof start.previous === "object" ? (start.previous as Previous) : null;
    if (previous) {
      out.set(start, { how: describeResidual(previous), linked: Boolean(previous.run), abnormal: true });
      return;
    }
    const prior = starts[index - 1];
    const prevRun = typeof prior?.run === "string" ? (prior.run as string) : null;
    if (prior && prevRun) {
      const exit = finished.find((candidate) => candidate.runId === prevRun);
      // 账本里给那一轮记了残留（锁里的 runId，老记录没有 runId 时认进程号）：它是没收完尾就没了的。
      const residual = exits.find((candidate) => candidate.kind === "residual"
        && (candidate.runId ? candidate.runId === prevRun : candidate.pid === prior.pid && t(candidate) >= t(prior)));
      out.set(start, exit
        ? { how: describeExit(exit), linked: true, abnormal: false }
        : residual
          ? { how: describeResidual({ evidence: residual.evidence, silentMs: residual.silentMs }), linked: true, abnormal: true }
          : { how: "上一份服务删掉了自己的锁（走过退出流程），但退出账本里没有它的记录", linked: true, abnormal: false });
      return;
    }
    // 上一轮不在这份日志里：退回按时间找最近的一条，并且明说是推测。
    const at = t(start);
    let guess: ExitSummary | undefined;
    for (const exit of finished) {
      if (t(exit) <= at && at - t(exit) < GUESS_WINDOW_MS && exit.runId !== start.run) guess = exit;
    }
    if (guess) out.set(start, { how: `（按时间推测）${describeExit(guess)}`, linked: false, abnormal: false });
  });
  return out;
}
