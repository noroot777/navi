// 新设备申请连进这台 Navi 时弹系统通知（自用模式）。顶条（auth/DevicePairingAlert.tsx）只在有人看着页面时才看得见，
// 人不在跟前时那台设备就一直干等到申请过期。字照着顶条说，点了把窗口拉到前面，允许 / 拒绝在顶条上点。
//
// 不只认那一声广播：事件流上的 pair.requests（opened）是一次性的，断线、事件流重建、页面在后台重新加载的那段时间里递上来的
// 申请，连回来之后服务端不会再说一遍。所以这里按「还在等的申请」对账：每次连上事件流（头一次也算）取一份服务端此刻的名单，
// 加上广播里新来的那张，这台设备上还没通知过的才弹。
//
// 通知过哪几张记在 localStorage：同一台设备上几个页面共用一本，后开的页面不把别的页面弹过的再弹一遍。申请只活十分钟，
// 账上的条目过了 LEDGER_TTL_MS 就清掉。有页面在前台时不弹、但照样记一笔：人看见了顶条，之后断线重连不该再补一条。
import type { PairRequestView } from "@navi/shared";
import { authApi } from "./authApi.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { safeStorage } from "./safeStorage.ts";
import { showSystemNotice, systemNotifyEnabled } from "./systemNotify.ts";
import { frontSomewhere, startTaskViewing } from "./taskViewing.ts";

const LEDGER_KEY = "navi:pair-notified";
const LEDGER_TTL_MS = 15 * 60_000;

/** 申请 id → 记账时刻，已经清掉过期的。 */
function readLedger(now: number): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(safeStorage.get(LEDGER_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && now - entry[1] < LEDGER_TTL_MS,
    ));
  } catch {
    return {};
  }
}

function consider(requests: PairRequestView[]): void {
  if (!requests.length || !systemNotifyEnabled()) return;
  const now = Date.now();
  const ledger = readLedger(now);
  const fresh = requests.filter((request) => !(request.id in ledger));
  if (!fresh.length) return;
  for (const request of fresh) ledger[request.id] = now;
  safeStorage.set(LEDGER_KEY, JSON.stringify(ledger));
  if (frontSomewhere()) return;
  for (const request of fresh) {
    showSystemNotice({
      key: `pair:${request.id}`, title: `「${request.name}」想连接这台 Navi`, subtitle: "",
      body: `它屏幕上的配对码应为 ${request.code} · 来自 ${request.address}`, projectId: null, taskId: null,
    });
  }
}

/** 整个页面听一份（自用模式、放开了其他设备访问时挂）。返回退订。 */
export function startPairNotify(): () => void {
  startTaskViewing();
  let stopped = false;
  let connected = false;
  const reconcile = async () => {
    try {
      const { requests } = await authApi.pairRequests();
      if (!stopped) consider(requests);
    } catch {
      // 读不到名单（正好又断了）：下一次连上再对
    }
  };
  const offConnection = subscribeConnection((now) => {
    if (now && !connected) void reconcile();
    connected = now;
  });
  const offEvents = subscribeEvents((event) => {
    if (event.type === "pair.requests" && event.opened) consider([event.opened]);
  });
  return () => {
    stopped = true;
    offConnection();
    offEvents();
  };
}
