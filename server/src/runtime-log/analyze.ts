// 把服务端、页面、mac 壳三份运行日志对齐成一条时间线，找出每一次「窗口闪一下」是谁出了事。
//
// 「闪一下」在日志里的样子，**任何一种观察单独出现都算一次**，不靠另一来源补证据才成立：
//   · 壳：撤掉页面（`page.takedown`）、重载页面（`page.reload`）、网页进程被系统结束；
//   · 页面：崩到错误屏（`page.crash`）、主动整页重载（`page.reload`）、被整页刷新进来（`page.boot` nav=reload）；
//   · 服务：一次**重启**（`server.start` 且认得出上一轮，见 analyze-restart.ts）。
// 哪几条是同一次按身份认（analyze-occurrences.ts），不按时间挨得近不近。
//
// 原因先看这一次里**直接观察到的**东西，再拿别的来源去解释撤页：
//   1. 服务重启（壳报的新实例进程号对上了 server.start，或者只有服务自己的重启）→ 上一轮怎么没的按证据说
//   2. 网页进程被结束、页面崩了 —— 壳 / 页面自己看见的，不让旁边时间上碰巧的事盖掉
//   3. 撤页：电脑刚睡醒 → 服务卡住（卡顿区间跟撤页重叠，带调用栈、CPU、GC、当时的请求）→ 附近服务重启了
//      → 端口上换了人 / 连接被拒 / 查不到
//   4. 页面整页重载：谁发起的；同一次载入里报过的错
// 只靠时间对上的关联在证据里明说「按时间推测」，不当成已证实的因果。
import type { CauseKind, Incident, RuntimeLogRecord, RuntimeLogReport, StackTally } from "@navi/shared/runtime-log";
import { restartVerdicts, type RestartVerdict } from "./analyze-restart.js";
import { groupOccurrences, isShell, loadKey, type Occurrence } from "./analyze-occurrences.js";
import type { ExitSummary } from "./load.js";

const t = (record: { at: string }) => Date.parse(record.at);
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;

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
  return frames.find((frame) => /(?:^| )(?:server|shared|mcp|web)\//.test(frame)) ?? frames[0] ?? "?";
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
  const inflight = Array.isArray(stall.inflight) ? (stall.inflight as Array<{ method: string; route: string; ageMs: number; done?: boolean }>) : [];
  if (inflight.length) {
    lines.push(`卡住时在处理的请求：${inflight.map((r) => `${r.method} ${r.route}（${r.done ? `用了 ${secs(r.ageMs)}，已完成` : `已 ${secs(r.ageMs)}`}）`).join("、")}`);
  }
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

type Context = {
  all: RuntimeLogRecord[];
  restarts: Map<RuntimeLogRecord, RestartVerdict>;
};

function restartEvidence(start: RuntimeLogRecord, verdict: RestartVerdict, all: RuntimeLogRecord[], from: number): string[] {
  const lines = [verdict.how];
  const errors = within(all, from - 120_000, t(start), (r) => r.ev === "server.error" && r.src === "server");
  if (errors.length) lines.push(`重启前服务报过异常：${errors.map((e) => `${e.name}${e.code ? `(${e.code})` : ""}`).join("、")}`);
  if (start.startupMs) lines.push(`新的那份从进程启动到能应答用了 ${secs(Number(start.startupMs))}`);
  return lines;
}

/** 被单例锁挡回的那几份里，哪些是这个窗口起的（壳记下的 spawn 进程号 = 被挡回的进程号）。 */
function refusedEvidence(all: RuntimeLogRecord[], from: number, to: number): string[] {
  const refused = within(all, from, to, (r) => r.ev === "server.refused");
  if (!refused.length) return [];
  const spawned = new Set(within(all, from - 60_000, to, (r) => r.ev === "server.spawn").map((r) => r.serverPid));
  const ours = refused.filter((r) => spawned.has(r.pid));
  const lines: string[] = [];
  if (ours.length) lines.push(`窗口以为服务没了又起了一份（进程 ${ours.map((r) => r.pid).join("、")}），被单例锁挡回——原来那份其实还活着`);
  if (refused.length > ours.length) lines.push(`同一时段另有 ${refused.length - ours.length} 次服务启动被单例锁挡回（不是这个窗口起的）`);
  return lines;
}

function describeTakedown(takedown: RuntimeLogRecord): string {
  // 壳记的是那一次探活的结果（RuntimeLog.fields(of:)）：down / unreachable / not_navi / not_ours。
  const probe = String(takedown.probe ?? "");
  const streak = takedown.streak ? `连续 ${takedown.streak} 次` : "";
  const what: Record<string, string> = {
    unreachable: `${streak}探活没等到答复`, down: "探活连接被拒",
    not_navi: `探活收到非 Navi 的答复（${takedown.status ?? "?"}）`, not_ours: "端口上已经不是自己那份服务",
  };
  return `窗口撤下页面：${what[probe] ?? probe}`;
}

/** 壳那一侧看见的「页面不在了」：撤页、没载出来、载进来了没显示出来。 */
function describeShellFailure(failure: RuntimeLogRecord): string {
  if (failure.ev === "page.takedown") return describeTakedown(failure);
  if (failure.ev === "page.load_failed") return `窗口没载出页面，换成了离线提示（${failure.domain ?? "?"} ${failure.code ?? "?"}）`;
  return `页面载进来了，但${failure.why === "script" ? "脚本没载成" : "等到超时也没显示出来"}，窗口换成了「页面没有显示出来」`;
}

const RELOAD_REASONS: Record<string, string> = {
  identity: "登录身份在别的标签页里变了", account: "账号设置里退出登录", "remote-access": "远程访问设置里退出登录",
  "error-screen": "在错误屏上点了重新载入", "load-failure": "在加载失败提示上点了刷新", reclaim: "放开回合占位后重新加载",
};

function classify(occurrence: Occurrence, { all, restarts }: Context): Omit<Incident, "timeline"> {
  const { seen } = occurrence;
  const start = t(seen[0]!);
  const end = t(seen.at(-1)!);
  const at = seen[0]!.at;
  const has = (ev: string, src?: (r: RuntimeLogRecord) => boolean) => seen.some((r) => r.ev === ev && (!src || src(r)));
  const evidence: string[] = [];
  const failures = seen.filter((r) => isShell(r) && (r.ev === "page.takedown" || r.ev === "page.load_failed" || r.ev === "page.not_presented"));
  const takedown = failures[0];
  for (const failure of failures.filter((f, i) => failures.findIndex((g) => g.ev === f.ev) === i)) evidence.push(describeShellFailure(failure));
  if (seen.some(isShell)) evidence.push(...refusedEvidence(all, start - 5_000, end + 60_000));

  // 同一次载入里报过的错（按载入身份认，不按时间）；没有载入标识的老记录只认这一次自己那几条。
  const pageErrors = all.filter((r) => r.src === "web" && (r.ev === "page.crash" || r.ev === "page.error")
    && (loadKey(r) ? occurrence.loads.has(loadKey(r)!) : seen.includes(r)));
  const describeErrors = () => {
    for (const error of pageErrors.slice(0, 2)) {
      const where = error.kind === "boundary" ? "页面里一块的兜底接住了报错" : "页面报错";
      evidence.push(`${where} ${error.name ?? "?"}${error.msg ? `：${error.msg}` : ""}${Array.isArray(error.frames) && error.frames.length ? `（${(error.frames as string[])[0]}）` : ""}`);
    }
  };
  const restartLines = (byTime: boolean) => {
    for (const { start: restart } of occurrence.restarts.filter((r) => r.byTime === byTime)) {
      if (byTime) evidence.push(`（按时间推测）${restart.at < at ? "之前" : "之后"} ${secs(Math.abs(t(restart) - start))} 有一次服务重启`);
      evidence.push(...restartEvidence(restart, restarts.get(restart)!, all, start));
    }
  };

  // 1. 这一次里直接看到了重启。
  const direct = occurrence.restarts.filter((r) => !r.byTime);
  if (direct.length) {
    restartLines(false);
    return { at, cause: "restart", summary: direct.length > 1 ? `服务连着重启了 ${direct.length} 次` : "服务重启了", evidence };
  }
  if (has("page.reload", (r) => isShell(r) && r.reason === "instance_changed")) {
    evidence.push("窗口发现服务的实例号变了（服务重启过），但没有那份新服务的启动记录");
    return { at, cause: "restart", summary: "服务重启了", evidence };
  }

  // 2. 壳 / 页面自己看见的故障。
  if (has("webcontent.terminated")) {
    return { at, cause: "webcontent", summary: "窗口的网页进程被系统结束了（多半是内存压力或 WebKit 崩溃），整页重载", evidence };
  }
  if (has("page.crash")) {
    describeErrors();
    return { at, cause: "page_error", summary: "页面脚本出错，整页换成了错误屏", evidence };
  }

  // 3. 壳那一侧页面不在了：拿服务那一侧的记录解释它。
  if (takedown) {
    const sleep = within(all, start - 30_000, end + 5_000, (r) => r.ev === "system.sleep");
    if (sleep.length) {
      evidence.push(`（按时间推测）服务在撤页前 ${secs(start - t(sleep[0]!))} 记到电脑睡了 ${secs(Number(sleep[0]!.ms ?? 0))}`);
      return { at, cause: "sleep", summary: "电脑刚从睡眠中醒来，醒来那一下探活没连上", evidence };
    }
    const stalls = all.filter((r) => r.ev === "loop.stall" && r.src === "server");
    const stacks = all.filter((r) => r.ev === "loop.stall.stack");
    const overlapping = stalls.filter((stall) => {
      const [from, to] = stallInterval(stall);
      return from <= t(takedown) + 1_000 && to >= t(takedown) - 8_000;
    }).sort((a, b) => Number(b.ms) - Number(a.ms));
    if (overlapping.length) {
      evidence.push(...describeStall(overlapping[0]!, stacks));
      return { at, cause: "stall", summary: `服务卡住 ${secs(Number(overlapping[0]!.ms))} 没应答，窗口当成服务没了`, evidence };
    }
    if (occurrence.restarts.length) {
      restartLines(true);
      return { at, cause: "restart", summary: "服务没了，随后重启", evidence };
    }
    const loadFailed = failures.find((f) => f.ev === "page.load_failed");
    const notPresented = failures.find((f) => f.ev === "page.not_presented");
    const probed = failures.find((f) => f.ev === "page.takedown");
    if (!probed && loadFailed) return { at, cause: "load_failed", summary: "窗口载页面失败（网络层报错），服务端没有对应的卡顿或重启", evidence };
    if (!probed && notPresented) return { at, cause: "not_presented", summary: "页面载进来了却没显示出来，服务端没有对应的卡顿或重启", evidence };
    if (probed?.probe === "not_ours" || probed?.probe === "not_navi") {
      return { at, cause: "not_ours", summary: "端口上应答的不是自己那份服务（被别的 Navi 或别的程序占了）", evidence };
    }
    if (probed?.probe === "down") {
      return { at, cause: "refused_connection", summary: "服务端口拒绝连接，但服务端没有重启记录", evidence };
    }
    const serverNearby = within(all, start - 15 * 60_000, end + 15 * 60_000, (r) => r.src === "server");
    evidence.push(serverNearby.length
      ? "服务端这段时间没有卡顿（≥1 秒）、重启、睡眠记录——多半是机器整体被压着（CPU/内存/磁盘满载）或者网络栈的问题"
      : "这段时间没有服务端日志（服务是旧版本、没起来，或者日志被删了）");
    return { at, cause: "unknown", summary: "没查到服务端那一侧的原因", evidence };
  }

  // 4. 页面整页重载。
  const webReload = seen.find((r) => r.src === "web" && r.ev === "page.reload");
  if (webReload) {
    describeErrors();
    return { at, cause: "reload", summary: `页面整页重载：${RELOAD_REASONS[String(webReload.reason)] ?? "原因没报上来"}`, evidence };
  }
  if (has("page.reload", (r) => isShell(r) && r.reason === "user")) {
    return { at, cause: "reload", summary: "在窗口菜单里点了重新载入", evidence };
  }
  if (pageErrors.length) {
    describeErrors();
    return { at, cause: "page_error", summary: "页面报错之后被整页刷新", evidence };
  }
  if (occurrence.restarts.length) {
    restartLines(true);
    return { at, cause: "restart", summary: "页面被整页刷新，附近服务重启过", evidence };
  }
  return { at, cause: "reload", summary: "页面被整页刷新（浏览器刷新 / ⌘R，或浏览器自己重载）", evidence };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * `sinceMs`：只报这之后的。`records` 可以带着窗口之前的记录当上下文（load.ts 会带上窗口前最后一次服务启动）：
 * 认上一轮、归并都在全量上做，结果再按窗口筛——先筛再认，窗口里第一次重启的上一轮就被裁掉了。
 */
export function analyzeRuntimeLog(records: RuntimeLogRecord[], exits: ExitSummary[], sinceMs: number | null = null): RuntimeLogReport {
  const all = [...records].sort((a, b) => t(a) - t(b));
  const inWindow = (at: string) => sinceMs === null || Date.parse(at) >= sinceMs;
  const sorted = all.filter((r) => inWindow(r.at));
  const counts: Record<string, number> = {};
  for (const record of sorted) counts[record.src] = (counts[record.src] ?? 0) + 1;

  const restartMap = restartVerdicts(all, exits);
  const incidents: Incident[] = groupOccurrences(all, restartMap).filter((occurrence) => inWindow(occurrence.seen[0]!.at)).map((occurrence) => {
    const verdict = classify(occurrence, { all, restarts: restartMap });
    const from = t(occurrence.seen[0]!) - 20_000;
    const to = t(occurrence.seen.at(-1)!) + 10_000;
    // 别的标签页的页面事件不进这一次的时间线。
    const tabs = new Set(occurrence.seen.filter((r) => r.src === "web").map((r) => r.tab));
    const timeline = within(all, from, to, (r) => r.ev !== "server.vitals" && (r.src !== "web" || !r.tab || tabs.size === 0 || tabs.has(r.tab))).slice(0, 40);
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

  const restarts = [...restartMap].filter(([start, verdict]) => verdict.basis !== "none" && inWindow(start.at)).map(([start, verdict]) => ({ at: start.at, how: verdict.how }));

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
