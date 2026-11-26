// 把服务端、页面、mac 壳三份运行日志对齐成一条时间线，找出每一次「窗口闪一下」是谁出了事。
//
// 每一次**只由亲眼看到它的那一方来数**（analyze-occurrences.ts）：桌面壳里由壳数，页面只数壳看不见的崩溃和
// 自己发起的重载，浏览器里再加上被整页刷新。服务重启没有窗口看见就不算一次，只进「服务重启」清单。
//
// 原因先看看到它的那一方自己说了什么：
//   1. 壳发现服务的实例号变了 → 服务重启；网页进程被结束；页面崩了；页面自己发起重载（谁发起的）
//   2. 壳那一侧页面不在了（撤页 / 没载出来 / 没显示出来）：电脑刚睡醒 → 服务卡住（卡顿区间跟出事时刻重叠，带
//      调用栈、CPU、GC、当时的请求）→ 附近有服务重启 → 端口上换了人 / 连接被拒 / 查不到
//   3. 窗口菜单里点了重载；浏览器里被整页刷新：刷新之前那一页报过的错
// 别的来源只是时间上对得上的，在证据里一律标「按时间对上」，不当成已证实的因果；上一轮服务怎么停的只说
// 记录里写了什么（analyze-restart.ts）。
import type { CauseKind, Incident, Observer, RuntimeLogRecord, RuntimeLogReport, StackTally } from "@navi/shared/runtime-log";
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

/** 别的来源在这一次附近的记录只按时间对得上，统一这样标：附在证据里，不当成已证实的原因。 */
const NEAR = "（按时间对上）";

/** `[from, to]` 里离 `at` 最近的一次认得出上一轮的服务重启。 */
function nearbyRestart(all: RuntimeLogRecord[], restarts: Map<RuntimeLogRecord, RestartVerdict>, from: number, to: number, at: number) {
  const candidates = within(all, from, to, (r) => r.ev === "server.start" && (restarts.get(r)?.basis ?? "none") !== "none");
  return candidates.sort((a, b) => Math.abs(t(a) - at) - Math.abs(t(b) - at))[0];
}

function classify(occurrence: Occurrence, { all, restarts }: Context): Omit<Incident, "timeline" | "seenBy"> {
  const { seen } = occurrence;
  const start = t(seen[0]!);
  const end = t(seen.at(-1)!);
  const at = seen[0]!.at;
  const has = (ev: string, src?: (r: RuntimeLogRecord) => boolean) => seen.some((r) => r.ev === ev && (!src || src(r)));
  const evidence: string[] = [];
  const failures = seen.filter((r) => isShell(r) && (r.ev === "page.takedown" || r.ev === "page.load_failed" || r.ev === "page.not_presented"));
  for (const failure of failures.filter((f, i) => failures.findIndex((g) => g.ev === f.ev) === i)) evidence.push(describeShellFailure(failure));
  if (seen.some(isShell)) evidence.push(...refusedEvidence(all, start - 5_000, end + 60_000).map((line) => `${NEAR}${line}`));

  // 同一次载入里报过的错（页面自己那条线，按载入身份认）；没有载入标识的老记录只认这一次自己那几条。
  const pageErrors = all.filter((r) => r.src === "web" && (r.ev === "page.crash" || r.ev === "page.error")
    && (loadKey(r) ? occurrence.loads.has(loadKey(r)!) : seen.includes(r)));
  // 整页崩溃那一条排在最前：它才是换成错误屏的那一下，前面的普通报错只是上下文。
  const describeErrors = () => {
    const ordered = [...pageErrors.filter((r) => r.ev === "page.crash"), ...pageErrors.filter((r) => r.ev !== "page.crash")];
    for (const error of ordered.slice(0, 2)) {
      const where = error.kind === "boundary" ? "页面里一块的兜底接住了报错" : "页面报错";
      evidence.push(`${where} ${error.name ?? "?"}${error.msg ? `：${error.msg}` : ""}${Array.isArray(error.frames) && error.frames.length ? `（${(error.frames as string[])[0]}）` : ""}`);
    }
  };
  const restartNear = (from: number, to: number) => {
    const restart = nearbyRestart(all, restarts, from, to, start);
    if (!restart) return false;
    const gap = t(restart) - start;
    evidence.push(`${NEAR}${gap <= 0 ? "这之前" : "这之后"} ${secs(Math.abs(gap))}，服务重启了一次`, ...restartEvidence(restart, restarts.get(restart)!, all, start));
    return true;
  };

  // 1. 看到它的那一方自己就说明了是怎么回事。
  if (has("page.reload", (r) => isShell(r) && r.reason === "instance_changed")) {
    restartNear(start - 10 * 60_000, end + 30_000);
    return { at, cause: "restart", summary: "窗口发现服务换了一份（实例号变了），重载了页面", evidence };
  }
  if (has("webcontent.terminated")) {
    return { at, cause: "webcontent", summary: "窗口的网页进程被系统结束了（多半是内存压力或 WebKit 崩溃），整页重载", evidence };
  }
  if (has("page.crash")) {
    describeErrors();
    return { at, cause: "page_error", summary: "页面脚本出错，整页换成了错误屏", evidence };
  }
  const webReload = seen.find((r) => r.src === "web" && r.ev === "page.reload");
  if (webReload) {
    describeErrors();
    return { at, cause: "reload", summary: `页面整页重载：${RELOAD_REASONS[String(webReload.reason)] ?? "原因没报上来"}`, evidence };
  }
  // 2. 壳那一侧页面不在了：自己说明不了为什么，附上服务那一侧时间对得上的记录。
  const failure = failures[0];
  if (failure) {
    const what = failure.ev === "page.takedown" ? "窗口撤下页面" : failure.ev === "page.load_failed" ? "窗口没载出页面" : "页面没显示出来";
    const sleep = within(all, start - 30_000, end + 5_000, (r) => r.ev === "system.sleep");
    if (sleep.length) {
      evidence.push(`${NEAR}服务在这之前 ${secs(start - t(sleep[0]!))} 记到电脑睡了 ${secs(Number(sleep[0]!.ms ?? 0))}`);
      return { at, cause: "sleep", summary: `${what}，时间上对得上电脑刚从睡眠中醒来`, evidence };
    }
    const stalls = all.filter((r) => r.ev === "loop.stall" && r.src === "server");
    const stacks = all.filter((r) => r.ev === "loop.stall.stack");
    const overlapping = stalls.filter((stall) => {
      const [from, to] = stallInterval(stall);
      return from <= t(failure) + 1_000 && to >= t(failure) - 8_000;
    }).sort((a, b) => Number(b.ms) - Number(a.ms));
    if (overlapping.length) {
      const [first, ...rest] = describeStall(overlapping[0]!, stacks);
      evidence.push(`${NEAR}${first}`, ...rest);
      return { at, cause: "stall", summary: `${what}，时间上对得上服务卡住了 ${secs(Number(overlapping[0]!.ms))}`, evidence };
    }
    if (restartNear(start - 90_000, end + 30_000)) {
      return { at, cause: "restart", summary: `${what}，时间上对得上服务重启`, evidence };
    }
    const probed = failures.find((f) => f.ev === "page.takedown");
    if (probed?.probe === "not_ours" || probed?.probe === "not_navi") {
      return { at, cause: "not_ours", summary: "端口上应答的不是自己那份服务（被别的 Navi 或别的程序占了）", evidence };
    }
    if (probed?.probe === "down") {
      return { at, cause: "refused_connection", summary: "服务端口拒绝连接，服务那一侧附近没有重启记录", evidence };
    }
    if (!probed && failure.ev === "page.load_failed") return { at, cause: "load_failed", summary: "窗口载页面失败（网络层报错），服务那一侧附近没有卡顿或重启", evidence };
    if (!probed) return { at, cause: "not_presented", summary: "页面载进来了却没显示出来，服务那一侧附近没有卡顿或重启", evidence };
    const serverNearby = within(all, start - 15 * 60_000, end + 15 * 60_000, (r) => r.src === "server");
    evidence.push(serverNearby.length
      ? "服务端这段时间没有卡顿（≥1 秒）、重启、睡眠记录——多半是机器整体被压着（CPU/内存/磁盘满载）或者网络栈的问题"
      : "这段时间没有服务端日志（服务是旧版本、没起来，或者日志被删了）");
    return { at, cause: "unknown", summary: "没查到服务端那一侧的原因", evidence };
  }

  // 3. 窗口菜单里点了重载。
  if (has("page.reload", (r) => isShell(r) && r.reason === "user")) {
    return { at, cause: "reload", summary: "在窗口菜单里点了重新载入", evidence };
  }

  // 浏览器里被整页刷新：刷新之前那一页报过的错是它自己那条线上的；服务重启只是时间对得上。
  if (pageErrors.length) {
    describeErrors();
    return { at, cause: "page_error", summary: "页面报错之后被整页刷新", evidence };
  }
  restartNear(start - 90_000, end + 30_000);
  return { at, cause: "reload", summary: "页面被整页刷新（浏览器刷新 / ⌘R，或浏览器自己重载）", evidence };
}

/** 页面那边记下的状态变化（不是详情）。 */
const PAGE_STATES = ["page.boot", "page.reload", "page.crash"];

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
  const incidents: Incident[] = groupOccurrences(all).filter((occurrence) => inWindow(occurrence.seen[0]!.at)).map((occurrence) => {
    const verdict = classify(occurrence, { all, restarts: restartMap });
    const from = t(occurrence.seen[0]!) - 20_000;
    const to = t(occurrence.seen.at(-1)!) + 10_000;
    // 别的标签页的页面事件不进这一次的时间线。
    const tabs = new Set(occurrence.seen.filter((r) => r.src === "web").map((r) => r.tab));
    const timeline = within(all, from, to, (r) => r.ev !== "server.vitals" && (r.src !== "web" || !r.tab || tabs.size === 0 || tabs.has(r.tab))).slice(0, 40);
    const seenBy: Observer = isShell(occurrence.seen[0]!) ? "window" : "page";
    return { ...verdict, seenBy, timeline };
  });
  const causes: Record<Observer, Partial<Record<CauseKind, number>>> = { window: {}, page: {} };
  for (const incident of incidents) causes[incident.seenBy][incident.cause] = (causes[incident.seenBy][incident.cause] ?? 0) + 1;

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
  for (const error of sorted.filter((r) => r.ev === "server.error" || r.ev === "server.startup_failed" || r.ev === "page.error" || r.ev === "page.crash")) {
    // 起不来的那次带上卡在哪一步，跟运行中没人接的异常分开数。
    const stage = error.ev === "server.startup_failed" ? `启动失败（${error.stage ?? "other"}）` : "";
    const name = `${[stage, error.name ?? (stage ? "" : "?")].filter(Boolean).join(" ")}${error.code ? `(${error.code})` : ""}${Array.isArray(error.frames) && error.frames.length ? ` @ ${(error.frames as string[])[0]}` : ""}`;
    const key = `${error.src}:${name}`;
    const tally = errorTally.get(key) ?? { src: error.src, name, count: 0, last: error.at };
    tally.count += 1;
    tally.last = error.at;
    errorTally.set(key, tally);
  }

  const notes: string[] = [];
  if (!counts.server) notes.push("没有服务端运行日志：服务端可能还是加日志之前的版本。");
  if (!counts.mac && !counts.win) notes.push("没有桌面壳的运行日志：用的是浏览器，或桌面 app 还是旧版本。");
  // 服务端按事件限流（journal.ts）：页面那边的状态变化被挡掉过，次数就只是下限，明说。开始丢的那一刻就有
  // `log.dropping`，带个数的 `log.dropped` 要等下一条同类事件才写（风暴停了、服务重启了就没有）。
  const dropRecords = sorted.filter((r) => (r.ev === "log.dropped" || r.ev === "log.dropping") && r.src === "web" && PAGE_STATES.includes(String(r.of)));
  if (dropRecords.length) {
    const counted = dropRecords.filter((r) => r.ev === "log.dropped").reduce((sum, r) => sum + Number(r.count ?? 0), 0);
    notes.push(`页面那边有${counted ? `至少 ${counted} 条` : "一些"}载入 / 重载 / 崩溃记录超过每分钟上限没记下来，页面看到的次数只是下限。`);
  }

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
