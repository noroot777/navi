// 把服务端、页面、mac 壳三份运行日志对齐成一条时间线，找出每一次「窗口闪一下」是谁出了事。
//
// 「闪一下」在日志里的样子（锚点）：mac 壳撤掉页面（`page.takedown`）、壳自己重载页面（`page.reload`，
// 不算用户按的）、网页进程被系统结束（`webcontent.terminated`）、页面自己整页重载（web `page.reload`）、
// 服务重新起来（`server.start`）。相隔不到 15 秒的锚点算同一次。
//
// 每一次在前后一段时间里找证据，按下面的顺序认定原因（前面的更具体）：
//   1. 电脑刚睡醒       `system.sleep`
//   2. 服务重启过       `server.start` / 壳报实例号变了 → 再看退出账本：正常收到信号、自己退出、还是什么都没留下
//   3. 服务卡住了       `loop.stall` 跟撤页时刻重叠 → 带上调用栈、CPU、GC、当时在处理的请求
//   4. 网页进程被结束   `webcontent.terminated`
//   5. 页面脚本出错     web `page.crash` / `page.error`
//   6. 端口上换了人 / 连接被拒 / 查不到服务端证据
import type { CauseKind, Incident, RuntimeLogRecord, RuntimeLogReport, StackTally } from "@navi/shared/runtime-log";
import type { ExitSummary } from "./load.js";

const MERGE_MS = 15_000;
const t = (record: { at: string }) => Date.parse(record.at);
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;

function isAnchor(record: RuntimeLogRecord): boolean {
  if (record.src === "mac" || record.src === "win") {
    if (record.ev === "page.takedown" || record.ev === "webcontent.terminated") return true;
    if (record.ev === "page.reload") return record.reason !== "user";
  }
  if (record.src === "web" && record.ev === "page.reload") return true;
  return record.src === "server" && record.ev === "server.start";
}

function within(records: RuntimeLogRecord[], from: number, to: number, pred: (r: RuntimeLogRecord) => boolean) {
  return records.filter((r) => { const at = t(r); return at >= from && at <= to && pred(r); });
}

function stallInterval(stall: RuntimeLogRecord): [number, number] {
  const end = t(stall);
  const from = typeof stall.from === "string" ? Date.parse(stall.from) : end - Number(stall.ms ?? 0);
  return [from, end];
}

function isCpuBound(stall: RuntimeLogRecord): boolean {
  return Number(stall.cpuMs ?? 0) >= Number(stall.ms ?? 1) * 0.6;
}

/** 栈里第一帧 navi 自己的代码（叶子往根找）；没有就是叶子那一帧。 */
function hotFrame(frames: string[]): string {
  return frames.find((frame) => / (server|shared|mcp|web)\//.test(frame)) ?? frames[0] ?? "?";
}

function describeStall(stall: RuntimeLogRecord, stacks: RuntimeLogRecord[]): string[] {
  const ms = Number(stall.ms ?? 0);
  const cpu = Number(stall.cpuMs ?? 0);
  const lines = [
    `服务主线程卡了 ${secs(ms)}（${new Date(stallInterval(stall)[0]).toLocaleTimeString("zh-CN", { hour12: false })} 起）`
      + `，这期间用掉 CPU ${secs(cpu)}——${isCpuBound(stall) ? "一直在算（JS 计算 / 同步处理大数据）" : "大部分时间在等（同步子进程、同步读写文件，或进程没被调度）"}`,
  ];
  const gc = Number(stall.gcMs ?? 0);
  if (gc >= 200) lines.push(`其中垃圾回收占 ${secs(gc)}，当时堆 ${stall.heapMB} MB、常驻内存 ${stall.rssMB} MB`);
  const inflight = Array.isArray(stall.inflight) ? (stall.inflight as Array<{ method: string; route: string; ageMs: number }>) : [];
  if (inflight.length) lines.push(`卡住时在处理的请求：${inflight.map((r) => `${r.method} ${r.route}（已 ${secs(r.ageMs)}）`).join("、")}`);
  const stack = stacks.find((s) => s.pid === stall.pid && s.n === stall.n);
  if (stack && Array.isArray(stack.stacks)) {
    for (const entry of (stack.stacks as Array<{ pct: number; frames: string[] }>).slice(0, 2)) {
      lines.push(`卡顿时 ${entry.pct}% 的采样在：${entry.frames.slice(0, 5).join(" ← ")}`);
    }
  } else if (ms >= 1500) {
    lines.push("这一次没有调用栈（采样器在第一次长卡顿之后才打开，之后的卡顿会带上）");
  }
  return lines;
}

function describeExit(exit: ExitSummary | undefined, residual: ExitSummary | undefined): string {
  if (exit?.kind === "signal") return `上一份服务收到 ${exit.signal} 退出（运行了 ${secs(Number(exit.uptimeMs ?? 0))}）——有人让它停的：升级、npm run restart、装更新或关机`;
  if (exit?.kind === "exit") return `上一份服务自己退出了（退出码 ${exit.code ?? "?"}）`;
  if (residual) {
    const silent = residual.silentMs ? `，最后一次心跳之后静默 ${secs(Number(residual.silentMs))}` : "";
    return residual.evidence === "exit_intent"
      ? `上一份服务进入过退出流程但没收完尾${silent}`
      : `上一份服务没留下任何退出记录就没了${silent}——被强杀（kill -9）、系统内存不够被结束，或原生崩溃`;
  }
  return "退出账本里没找到上一份服务怎么停的";
}

/** 这一次启动之前最近的那条退出记录（10 分钟内），和这一次启动时记下的残留锁。 */
function exitBefore(exits: ExitSummary[], startMs: number): ExitSummary | undefined {
  for (let i = exits.length - 1; i >= 0; i -= 1) {
    const exit = exits[i]!;
    if (exit.kind !== "residual" && t(exit) <= startMs && startMs - t(exit) < 10 * 60_000) return exit;
  }
  return undefined;
}

function residualAt(exits: ExitSummary[], startMs: number): ExitSummary | undefined {
  return exits.find((exit) => exit.kind === "residual" && Math.abs(t(exit) - startMs) < 120_000);
}

function classify(cluster: RuntimeLogRecord[], all: RuntimeLogRecord[], exits: ExitSummary[], firstStart: RuntimeLogRecord | undefined): Omit<Incident, "timeline"> {
  const start = t(cluster[0]!);
  const end = t(cluster[cluster.length - 1]!);
  const at = cluster[0]!.at;
  const has = (ev: string, src?: string) => cluster.some((r) => r.ev === ev && (!src || r.src === src));
  const takedown = cluster.find((r) => r.ev === "page.takedown");
  const evidence: string[] = [];
  if (takedown) {
    // 壳记的是那一次探活的结果（RuntimeLog.fields(of:)）：down / unreachable / not_navi / not_ours。
    const reason = String(takedown.probe ?? "");
    const streak = takedown.streak ? `连续 ${takedown.streak} 次` : "";
    evidence.push(`窗口撤下页面：${{ unreachable: `${streak}探活没等到答复`, down: "探活连接被拒", not_navi: `探活收到非 Navi 的答复（${takedown.status ?? "?"}）`, not_ours: "端口上已经不是自己那份服务" }[reason] ?? reason}`);
  }
  const refused = within(all, start - 5_000, end + 60_000, (r) => r.ev === "server.refused");
  if (refused.length) evidence.push(`窗口以为服务没了又起了一份，被单例锁挡回（${refused.length} 次）——原来那份其实还活着`);

  const sleep = within(all, start - 60_000, end + 5_000, (r) => r.ev === "system.sleep");
  if (sleep.length) {
    return { at, cause: "sleep", summary: `电脑刚从睡眠中醒来（睡了 ${secs(Number(sleep[0]!.ms ?? 0))}），醒来那一下探活没连上`, evidence };
  }

  // 「新起的那一份」：这一次里自己就有的那条 server.start，没有就取撤页之后最先起来的那条。
  const starts = within(all, start - 30_000, end + 90_000, (r) => r.ev === "server.start" && r !== firstStart);
  const instanceChanged = cluster.find((r) => r.ev === "page.reload" && r.reason === "instance_changed");
  if (starts.length || instanceChanged) {
    const started = cluster.find((r) => r.ev === "server.start") ?? starts.find((r) => t(r) >= start - 5_000) ?? starts[starts.length - 1];
    const startedAt = started ? t(started) : end;
    const exit = exitBefore(exits, startedAt);
    const residual = started ? residualAt(exits, startedAt) : undefined;
    const errors = within(all, start - 120_000, end, (r) => r.ev === "server.error" && r.src === "server");
    const how = describeExit(exit, residual);
    evidence.push(how);
    if (errors.length) evidence.push(`重启前服务报过异常：${errors.map((e) => `${e.name}${e.code ? `(${e.code})` : ""}`).join("、")}`);
    if (started?.startupMs) evidence.push(`新的那份从进程启动到能应答用了 ${secs(Number(started.startupMs))}`);
    return { at, cause: "restart", summary: "服务重启了", evidence };
  }

  const stalls = all.filter((r) => r.ev === "loop.stall" && r.src === "server");
  const stacks = all.filter((r) => r.ev === "loop.stall.stack");
  const overlapping = stalls.filter((stall) => {
    const [from, to] = stallInterval(stall);
    return from <= end + 1_000 && to >= start - 8_000;
  }).sort((a, b) => Number(b.ms) - Number(a.ms));
  if (overlapping.length) {
    evidence.push(...describeStall(overlapping[0]!, stacks));
    return { at, cause: "stall", summary: `服务卡住 ${secs(Number(overlapping[0]!.ms))} 没应答，窗口当成服务没了`, evidence };
  }

  if (has("webcontent.terminated")) {
    return { at, cause: "webcontent", summary: "窗口的网页进程被系统结束了（多半是内存压力或 WebKit 崩溃），整页重载", evidence };
  }

  const pageErrors = within(all, start - 10_000, end, (r) => r.src === "web" && (r.ev === "page.crash" || r.ev === "page.error"));
  const webReload = cluster.find((r) => r.src === "web" && r.ev === "page.reload");
  if (pageErrors.length || webReload?.reason === "error-screen") {
    for (const error of pageErrors.slice(0, 2)) evidence.push(`页面报错 ${error.name ?? "?"}${error.msg ? `：${error.msg}` : ""}${Array.isArray(error.frames) && error.frames.length ? `（${(error.frames as string[])[0]}）` : ""}`);
    return { at, cause: "page_error", summary: "页面脚本出错", evidence };
  }
  if (webReload) {
    const why: Record<string, string> = { identity: "登录身份在别的标签页里变了", account: "账号设置要求重载", "remote-access": "远程访问设置要求重载", reclaim: "接管回合后重载" };
    return { at, cause: "unknown", summary: `页面自己整页重载：${why[String(webReload.reason)] ?? String(webReload.reason)}`, evidence };
  }
  if (takedown?.probe === "not_ours" || takedown?.probe === "not_navi") {
    return { at, cause: "not_ours", summary: "端口上应答的不是自己那份服务（被别的 Navi 或别的程序占了）", evidence };
  }
  if (takedown?.probe === "down") {
    return { at, cause: "refused_connection", summary: "服务端口拒绝连接，但服务端没有重启记录", evidence };
  }
  const serverNearby = within(all, start - 15 * 60_000, end + 15 * 60_000, (r) => r.src === "server");
  evidence.push(serverNearby.length
    ? "服务端这段时间没有卡顿（≥1 秒）、重启、睡眠记录——多半是机器整体被压着（CPU/内存/磁盘满载）或者网络栈的问题"
    : "这段时间没有服务端日志（服务是旧版本、没起来，或者日志被删了）");
  return { at, cause: "unknown", summary: "没查到服务端那一侧的原因", evidence };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function analyzeRuntimeLog(records: RuntimeLogRecord[], exits: ExitSummary[]): RuntimeLogReport {
  const sorted = [...records].sort((a, b) => t(a) - t(b));
  const counts: Record<string, number> = {};
  for (const record of sorted) counts[record.src] = (counts[record.src] ?? 0) + 1;

  // 服务端的第一条 server.start 不是「重启」：那是日志开始记以来第一次起。
  const firstStart = sorted.find((r) => r.ev === "server.start");
  const anchors = sorted.filter((r) => isAnchor(r) && r !== firstStart);
  const clusters: RuntimeLogRecord[][] = [];
  for (const anchor of anchors) {
    const last = clusters[clusters.length - 1];
    if (last && t(anchor) - t(last[last.length - 1]!) <= MERGE_MS) last.push(anchor);
    else clusters.push([anchor]);
  }
  const incidents: Incident[] = clusters.map((cluster) => {
    const verdict = classify(cluster, sorted, exits, firstStart);
    const from = t(cluster[0]!) - 20_000;
    const to = t(cluster[cluster.length - 1]!) + 10_000;
    const timeline = within(sorted, from, to, (r) => r.ev !== "server.vitals").slice(0, 40);
    return { ...verdict, timeline };
  });
  const causes: Partial<Record<CauseKind, number>> = {};
  for (const incident of incidents) causes[incident.cause] = (causes[incident.cause] ?? 0) + 1;

  const stalls = sorted.filter((r) => r.ev === "loop.stall");
  const stallMs = stalls.map((s) => Number(s.ms ?? 0));
  const hot = new Map<string, StackTally>();
  for (const stack of sorted.filter((r) => r.ev === "loop.stall.stack")) {
    const top = (stack.stacks as Array<{ pct: number; frames: string[] }> | undefined)?.[0];
    if (!top) continue;
    const frame = hotFrame(top.frames);
    const tally = hot.get(frame) ?? { frame, stalls: 0, ms: 0 };
    tally.stalls += 1;
    tally.ms += Math.round(Number(stack.ms ?? 0) * (top.pct / 100));
    hot.set(frame, tally);
  }

  const restarts = sorted.filter((r) => r.ev === "server.start" && r !== firstStart)
    .map((start) => ({ at: start.at, how: describeExit(exitBefore(exits, t(start)), residualAt(exits, t(start))) }));

  const errorTally = new Map<string, { src: string; name: string; count: number; last: string }>();
  for (const error of sorted.filter((r) => r.ev === "server.error" || r.ev === "page.error" || r.ev === "page.crash")) {
    const name = `${error.name ?? "?"}${error.code ? `(${error.code})` : ""}${Array.isArray(error.frames) && error.frames.length ? ` @ ${(error.frames as string[])[0]}` : ""}`;
    const key = `${error.src}:${name}`;
    const tally = errorTally.get(key) ?? { src: error.src, name, count: 0, last: error.at };
    tally.count += 1;
    tally.last = error.at;
    errorTally.set(key, tally);
  }

  const notes: string[] = [];
  if (!counts.server) notes.push("没有服务端运行日志：服务端可能还是加日志之前的版本。");
  if (!counts.mac && !counts.win) notes.push("没有桌面壳的运行日志：用的是浏览器，或桌面 app 还是旧版本。");

  return {
    from: sorted[0]?.at ?? null,
    to: sorted[sorted.length - 1]?.at ?? null,
    counts,
    incidents,
    causes,
    stalls: {
      total: stalls.length,
      overOneAndHalf: stallMs.filter((ms) => ms >= 1500).length,
      maxMs: stallMs.length ? Math.max(...stallMs) : 0,
      medianMs: median(stallMs),
      cpuBound: stalls.filter(isCpuBound).length,
      waiting: stalls.filter((s) => !isCpuBound(s)).length,
    },
    hotspots: [...hot.values()].sort((a, b) => b.ms - a.ms).slice(0, 5),
    restarts,
    errors: [...errorTally.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    notes,
  };
}
