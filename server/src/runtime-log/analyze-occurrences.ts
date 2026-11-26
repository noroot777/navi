// 把观察归成一次次「窗口闪一下」：**每一次只由亲眼看到它的那一方来数**，不跨来源合并。
//
// 前几轮审查一路证明「壳记的这条、页面记的那条、服务记的那条是同一次」都没收住：不同标签页、两份壳、
// 关掉重开、进程号复用，每补一种身份就有下一种串账。跨来源的「是同一次」日志本身证明不了，所以不做：
//   · 桌面壳里的页面由**壳**来数：撤页、没载出来、载进来了没显示出来、网页进程被结束、重载（用户点菜单的也是
//     壳记的）。同一个壳进程（`src` + `pid`，一个壳进程一个窗口）从出事到它自己记下页面又显示出来
//     （`page.presented`）或者退出，算一次——这是壳自己一条线上的事。壳里的页面再载进来（`page.boot`）不另算。
//   · 页面只数壳看不见的：崩到错误屏（`page.crash`）、页面自己发起的整页重载（`page.reload`）；浏览器里
//     （没有壳）再加上被整页刷新进来（`page.boot` nav=reload）。同一次载入（`load`）里的几条算一次，刷新进来的
//     那一页 `prev` 指着已经算过的那一次载入就不另算——这是页面自己一条线上的事。
//   · 服务重启不单独算「闪一下」：没有窗口看见就没有闪。它进「服务重启」清单，并作为**时间上附近的记录**附在
//     附近那一次的证据里（classify 里统一标「按时间对上」）。
import type { RuntimeLogRecord } from "@navi/shared/runtime-log";

export type Occurrence = {
  /** 看到这一次的那一方记下的，按时间排。 */
  seen: RuntimeLogRecord[];
  /** 这一次涉及的页面载入（`tab/load`）：同一次载入里的报错拿来解释它。 */
  loads: Set<string>;
};

export const isShell = (r: RuntimeLogRecord) => r.src === "mac" || r.src === "win";

/** 壳那一侧的可见故障。 */
const SHELL_FAILURES = ["page.takedown", "page.load_failed", "page.not_presented", "webcontent.terminated", "page.reload"];

export const loadKey = (r: RuntimeLogRecord) => (typeof r.tab === "string" && typeof r.load === "string" ? `${r.tab}/${r.load}` : null);
const prevKey = (r: RuntimeLogRecord) => (typeof r.tab === "string" && typeof r.prev === "string" ? `${r.tab}/${r.prev}` : null);
const t = (record: { at: string }) => Date.parse(record.at);

export function groupOccurrences(sorted: RuntimeLogRecord[]): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const create = (first: RuntimeLogRecord): Occurrence => {
    const occurrence: Occurrence = { seen: [first], loads: new Set() };
    occurrences.push(occurrence);
    return occurrence;
  };
  /** 页面那条线：已经算过的载入。 */
  const counted = new Map<string, Occurrence>();
  /** 壳那条线：每个壳进程还没收口的那一次。 */
  const openShell = new Map<string, Occurrence>();

  for (const r of sorted) {
    if (r.src === "web") {
      const key = loadKey(r);
      if (r.ev === "page.crash" || r.ev === "page.reload") {
        const known = key ? counted.get(key) : undefined;
        if (known) known.seen.push(r);
        else {
          const occurrence = create(r);
          if (key) {
            occurrence.loads.add(key);
            counted.set(key, occurrence);
          }
        }
      } else if (r.ev === "page.boot" && r.nav === "reload" && r.shell !== "mac" && r.shell !== "win") {
        const prev = prevKey(r);
        if (prev && counted.has(prev)) counted.get(prev)!.seen.push(r);
        else {
          const occurrence = create(r);
          // 刷新之前那一页报过的错，拿来解释这次刷新。
          if (prev) occurrence.loads.add(prev);
        }
      }
      continue;
    }
    if (!isShell(r)) continue;
    const key = `${r.src}:${String(r.pid)}`;
    if (r.ev === "page.presented" || r.ev === "app.quit" || r.ev === "app.launch") {
      openShell.delete(key);
    } else if (SHELL_FAILURES.includes(r.ev)) {
      const open = openShell.get(key);
      if (open) open.seen.push(r);
      else openShell.set(key, create(r));
    }
  }
  return occurrences.sort((a, b) => t(a.seen[0]!) - t(b.seen[0]!));
}
