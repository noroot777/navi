// 把各来源的观察归成一次次「窗口闪一下」，**按身份归并，时间只用来找候选**。
//
// 每条观察先认它属于哪一次：
//   · 页面：每一次载入有自己的标识（`load`），新载入的一页报上一次载入是哪个（`prev`）。同一次载入里的崩溃、
//     主动重载，和接着载进来、`prev` 指着它的那一页，是同一次；不同的载入从不合并，哪怕只隔一秒。
//     没有前因的整页刷新（浏览器刷新）自成一次。
//   · 壳：按**壳进程**（`src` + `pid`，一个壳进程一个窗口）。一次撤页 / 载入失败 / 没显示出来 / 重载 / 网页进程被
//     结束起头，到**这个壳进程**的页面回来为止——壳自己记的 `page.presented`、页面报的 `shellPid` 等于它的那一页，
//     或者壳退出（`app.quit`）——中间这个壳记的都是这一次（页面一直不在，撤几次都是同一次没回来）。
//     别的壳进程、别的窗口、浏览器里的页面都收不了它的口（第 3 轮审查：旧版按「同平台的下一页」收口，
//     两份壳各出一次事、关掉重开再出事都并成了一次）。页面没带 `shellPid`（老版本壳）就不并，各自成一次。
//   · 服务重启：壳报「实例号变了」带着新服务的进程号，跟**在它之前起来的** `server.start` 的进程号对上才归那一次；
//     对不上的才按时间找附近一次还没有解释的壳 / 页面观察（记成按时间推测）；都没有就自成一次（当时没有窗口在看）。
import type { RuntimeLogRecord } from "@navi/shared/runtime-log";
import type { RestartVerdict } from "./analyze-restart.js";

export type Occurrence = {
  /** 这一次里壳 / 页面 / 服务自己记下的观察，按时间排。 */
  seen: RuntimeLogRecord[];
  /** 归到这一次的服务重启；`byTime`：只是时间对得上。 */
  restarts: Array<{ start: RuntimeLogRecord; byTime: boolean }>;
  /** 这一次涉及的页面载入（`tab/load`）：同一次载入里的报错拿来解释它。 */
  loads: Set<string>;
};

export const isShell = (r: RuntimeLogRecord) => r.src === "mac" || r.src === "win";

/** 壳那一侧的可见故障：页面被撤下、没载出来、载进来了却没显示出来、网页进程被结束、被重载。 */
export const SHELL_FAILURES = ["page.takedown", "page.load_failed", "page.not_presented", "webcontent.terminated", "page.reload"];

/** 壳 / 页面那一侧没有说明原因、要拿服务那一侧来解释的观察。 */
export function needsExplaining(occurrence: Occurrence): boolean {
  return occurrence.seen.some((r) => (isShell(r) && ["page.takedown", "page.load_failed", "page.not_presented"].includes(r.ev))
    || (isShell(r) && r.ev === "page.reload" && r.reason === "instance_changed")
    || (r.src === "web" && r.ev === "page.boot" && r.nav === "reload"))
    && !occurrence.seen.some((r) => r.ev === "page.crash" || r.ev === "webcontent.terminated"
      || (r.src === "web" && r.ev === "page.reload") || (isShell(r) && r.ev === "page.reload" && r.reason === "user"));
}

export const loadKey = (r: RuntimeLogRecord) => (typeof r.tab === "string" && typeof r.load === "string" ? `${r.tab}/${r.load}` : null);
const prevKey = (r: RuntimeLogRecord) => (typeof r.tab === "string" && typeof r.prev === "string" ? `${r.tab}/${r.prev}` : null);
const shellKey = (src: unknown, pid: unknown) => `${String(src)}:${String(pid)}`;
const t = (record: { at: string }) => Date.parse(record.at);

/** 壳进程号对上了，但新服务得是在壳发现实例换了之前这么久以内起来的（进程号会被复用）。 */
const INSTANCE_MATCH_MS = 10 * 60_000;

export function groupOccurrences(sorted: RuntimeLogRecord[], restarts: Map<RuntimeLogRecord, RestartVerdict>): Occurrence[] {
  let occurrences: Occurrence[] = [];
  const create = (first: RuntimeLogRecord): Occurrence => {
    const occurrence: Occurrence = { seen: [first], restarts: [], loads: new Set() };
    occurrences.push(occurrence);
    return occurrence;
  };
  const endedLoads = new Map<string, Occurrence>();
  /** 每个壳进程还没收口的那一次。 */
  const openShell = new Map<string, Occurrence>();
  const merge = (into: Occurrence, from: Occurrence) => {
    if (into === from) return;
    into.seen.push(...from.seen);
    for (const key of from.loads) into.loads.add(key);
    for (const [key, value] of endedLoads) if (value === from) endedLoads.set(key, into);
    occurrences = occurrences.filter((o) => o !== from);
  };

  for (const r of sorted) {
    if (r.src === "web" && (r.ev === "page.crash" || r.ev === "page.reload")) {
      const key = loadKey(r);
      const known = key ? endedLoads.get(key) : undefined;
      if (known) known.seen.push(r);
      else {
        const occurrence = create(r);
        if (key) {
          occurrence.loads.add(key);
          endedLoads.set(key, occurrence);
        }
      }
      continue;
    }
    if (r.src === "web" && r.ev === "page.boot") {
      const prev = prevKey(r);
      let occurrence = prev ? endedLoads.get(prev) : undefined;
      if (occurrence) occurrence.seen.push(r);
      else if (r.nav === "reload") {
        occurrence = create(r);
        // 浏览器刷新之前那一页报过的错，拿来解释这次刷新。
        if (prev) occurrence.loads.add(prev);
      }
      // 这一页是哪个壳进程里的，壳那一次就等的是它：收口，跟页面自己那一次（有的话）合成一次。
      if (typeof r.shellPid === "number") {
        const key = shellKey(r.shell, r.shellPid);
        const shell = openShell.get(key);
        if (shell) {
          if (occurrence) merge(shell, occurrence);
          else shell.seen.push(r);
          openShell.delete(key);
        }
      }
      continue;
    }
    if (!isShell(r)) continue;
    const key = shellKey(r.src, r.pid);
    if (r.ev === "page.presented" || r.ev === "app.quit" || r.ev === "app.launch") {
      openShell.delete(key);
      continue;
    }
    if (SHELL_FAILURES.includes(r.ev)) {
      const open = openShell.get(key);
      if (open) open.seen.push(r);
      else openShell.set(key, create(r));
    }
  }

  for (const [start, verdict] of restarts) {
    if (verdict.basis === "none") continue;
    // 壳报的新实例进程号 = 这份服务的进程号，且服务先起来、壳随后才发现：就是这一次重启。
    const owners = occurrences.filter((o) => o.seen.some((r) => isShell(r) && r.ev === "page.reload" && r.reason === "instance_changed"
      && r.serverPid === start.pid && t(r) >= t(start) && t(r) - t(start) <= INSTANCE_MATCH_MS));
    if (owners.length) {
      for (const owner of owners) owner.restarts.push({ start, byTime: false });
      continue;
    }
    const at = t(start);
    const near = occurrences.filter((o) => needsExplaining(o) && o.restarts.length === 0 && t(o.seen[0]!) >= at - 90_000 && t(o.seen[0]!) <= at + 30_000);
    if (near.length) {
      for (const occurrence of near) occurrence.restarts.push({ start, byTime: true });
      continue;
    }
    create(start).restarts.push({ start, byTime: false });
  }

  for (const occurrence of occurrences) occurrence.seen.sort((a, b) => t(a) - t(b));
  return occurrences.sort((a, b) => t(a.seen[0]!) - t(b.seen[0]!));
}
