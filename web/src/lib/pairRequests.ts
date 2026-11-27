// 等机主点头的设备申请（自用模式），整个页面一份。顶条（auth/DevicePairingAlert.tsx）和系统通知（lib/pairNotify.ts）
// 读的是同一份名单，不各读各的：各自读的话一边读成了、一边读失败，失败的那边就一直不知道。
//
// 名单只从服务端读（GET /remote-access/requests），什么都只是「该重读了」的信号：定时轮询、事件流上的 pair.requests
// （申请递上来 / 被处理掉）、事件流连回来、页面回到可见、别处处理完申请（PAIR_REQUESTS_CHANGED_EVENT）。读失败就等
// 下一次信号，轮询保证下一次一定会来。几次读前后脚发出时只认最新发出的那次：处理掉一张之前发出的读晚回来，会把它带回来。
//
// 每读成一次都告诉订阅方一遍，哪怕名单没变：通知那边靠它重试上一次没弹出去的。
import type { PairRequestView } from "@navi/shared";
import { authApi } from "./authApi.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { PAIR_REQUESTS_CHANGED_EVENT } from "./pairing.ts";

const POLL_MS = 4_000;

type Listener = (requests: PairRequestView[]) => void;

const listeners = new Set<Listener>();
let current: PairRequestView[] | null = null;
let epoch = 0;
let stopWatching: (() => void) | null = null;

function publish(next: PairRequestView[]): void {
  current = next;
  for (const listener of listeners) listener(next);
}

async function reload(): Promise<void> {
  const mine = ++epoch;
  try {
    const next = (await authApi.pairRequests()).requests;
    if (mine === epoch && listeners.size) publish(next);
  } catch {
    // 读不到（正好断了、服务在重启）：下一次轮询或信号再读
  }
}

function watch(): () => void {
  const onReload = () => void reload();
  const timer = window.setInterval(onReload, POLL_MS);
  const onVisible = () => { if (document.visibilityState === "visible") onReload(); };
  window.addEventListener(PAIR_REQUESTS_CHANGED_EVENT, onReload);
  document.addEventListener("visibilitychange", onVisible);
  // 经 PAIR_REQUESTS_CHANGED_EVENT 转一道：设置页的「远程访问」卡也听它，跟着当场重读。
  const offEvents = subscribeEvents((event) => {
    if (event.type === "pair.requests") window.dispatchEvent(new Event(PAIR_REQUESTS_CHANGED_EVENT));
  });
  let connected = false;
  const offConnection = subscribeConnection((now) => {
    if (now && !connected) onReload();
    connected = now;
  });
  return () => {
    window.clearInterval(timer);
    window.removeEventListener(PAIR_REQUESTS_CHANGED_EVENT, onReload);
    document.removeEventListener("visibilitychange", onVisible);
    offEvents();
    offConnection();
  };
}

/** 订阅名单（没人订时不轮询）。已经读到过的，订上那一下先给一份。返回退订。 */
export function subscribePairRequests(listener: Listener): () => void {
  listeners.add(listener);
  if (current) listener(current);
  stopWatching ??= watch();
  void reload();
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopWatching) return;
    stopWatching();
    stopWatching = null;
    current = null;
    epoch += 1;
  };
}

/** 此刻最新的名单（还没读到过是空的）。 */
export function pairRequestsNow(): PairRequestView[] {
  return current ?? [];
}

/** 这一张刚在本页处理掉：先从名单里拿掉，之前发出、还没回来的读一律作废（回来的是旧的）。 */
export function dropPairRequest(id: string): void {
  epoch += 1;
  if (current) publish(current.filter((request) => request.id !== id));
}
