// 新设备申请连进这台 Navi 时弹系统通知（自用模式）。顶条（auth/DevicePairingAlert.tsx）只在有人看着页面时才看得见，
// 人不在跟前时那台设备就一直干等到申请过期。字照着顶条说，点了把窗口拉到前面，允许 / 拒绝在顶条上点。
//
// 按「此刻还在等的申请」对账，不按「收到过哪一声」：名单是 lib/pairRequests.ts 那一份（跟顶条同一份，轮询、事件流、
// 连回来都只是让它重读），每读成一次就对一遍 —— 这台设备上还没通知到的那几张弹出去。所以哪一下出了岔子都不会变成
// 「永远不弹」：断线期间递来的、某一次读失败的、某一次没弹出去的，下一份名单到了照样在里面，照样再对。
//
// 只有两种情形算「通知到了」、记进账里不再弹：交给系统那一下成了，或者此刻有 Navi 页面在前台（顶条就摆在那儿）。
// 开关关着不记：打开之后还在等的照样弹。交给系统之后它显没显示（mac / Windows 的通知中心不回话）这里管不着。
//
// 账记在 localStorage（同一台设备上几个页面共用一本，后开的页面不把别的页面弹过的再弹一遍），本页内存里再留一份
// （存储写不进去时也不会每读一次就弹一次）。几个页面同时对账靠 Web Locks 排成一个一个来：读账、弹、写账是一整下，
// 不然两个页面都读到「没弹过」就各弹一条。申请只活十分钟，账上的条目过了 LEDGER_TTL_MS 就清掉。
import type { PairRequestView } from "@navi/shared";
import { pairRequestsNow, subscribePairRequests } from "./pairRequests.ts";
import { safeStorage } from "./safeStorage.ts";
import { showSystemNotice, systemNotifyEnabled } from "./systemNotify.ts";
import { frontSomewhere, startTaskViewing } from "./taskViewing.ts";

const LEDGER_KEY = "navi:pair-notified";
const LOCK_NAME = "navi:pair-notify";
const LEDGER_TTL_MS = 15 * 60_000;

/** 申请 id → 通知到的时刻。存储读写不了时就靠它。 */
const remembered = new Map<string, number>();

function readLedger(now: number): Map<string, number> {
  const ledger = new Map<string, number>();
  try {
    const parsed: unknown = JSON.parse(safeStorage.get(LEDGER_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") {
      for (const [id, at] of Object.entries(parsed)) if (typeof at === "number") ledger.set(id, at);
    }
  } catch {
    // 账坏了：当作空账，内存里那份照样挡着本页弹过的
  }
  for (const [id, at] of remembered) ledger.set(id, Math.max(at, ledger.get(id) ?? 0));
  for (const [id, at] of ledger) if (now - at >= LEDGER_TTL_MS) ledger.delete(id);
  return ledger;
}

function writeLedger(ledger: Map<string, number>): void {
  remembered.clear();
  for (const [id, at] of ledger) remembered.set(id, at);
  safeStorage.set(LEDGER_KEY, JSON.stringify(Object.fromEntries(ledger)));
}

const noticeOf = (request: PairRequestView) => ({
  key: `pair:${request.id}`, title: `「${request.name}」想连接这台 Navi`, subtitle: "",
  body: `它屏幕上的配对码应为 ${request.code} · 来自 ${request.address}`, projectId: null, taskId: null,
});

/** 对一遍账。用的是此刻最新的名单（排队等锁期间又读到了新的，就按新的对；处理掉的已经不在里面）。 */
function reconcile(): void {
  if (!systemNotifyEnabled()) return;
  const now = Date.now();
  const ledger = readLedger(now);
  const due = pairRequestsNow().filter((request) => !ledger.has(request.id));
  if (!due.length) return;
  const front = frontSomewhere();
  for (const request of due) {
    if (front || showSystemNotice(noticeOf(request))) ledger.set(request.id, now);
  }
  writeLedger(ledger);
}

type Locks = { request: (name: string, callback: () => Promise<void> | void) => Promise<unknown> };

/** 几个页面排成一个一个来；没有 Web Locks（http 的局域网地址不是安全来源）就只在本页排。 */
function underDeviceLock(work: () => void): Promise<unknown> {
  const locks = (navigator as Navigator & { locks?: Locks }).locks;
  return locks ? locks.request(LOCK_NAME, work) : Promise.resolve().then(work);
}

/** 整个页面听一份（自用模式、放开了其他设备访问时挂）。返回退订。 */
export function startPairNotify(): () => void {
  startTaskViewing();
  let stopped = false;
  let running = false;
  let again = false;
  // 本页内也一次只对一遍：对着的时候又来了新名单，对完再来一遍（多来几份也只补一遍）。
  const kick = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void underDeviceLock(() => { if (!stopped) reconcile(); })
      .catch(() => {})
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          kick();
        }
      });
  };
  const unsubscribe = subscribePairRequests(kick);
  return () => {
    stopped = true;
    unsubscribe();
  };
}
