// 等机主点头的设备申请（自用模式），整个页面一份。顶条（auth/DevicePairingAlert.tsx）和系统通知（lib/pairNotify.ts）
// 读的是同一份名单，不各读各的：各自读的话一边读成了、一边读失败，失败的那边就一直不知道。
//
// 名单只从服务端读（GET /remote-access/requests），什么都只是「该重读了」的信号：定时轮询、事件流上的 pair.requests
// （申请递上来 / 被处理掉）、事件流连回来、页面回到可见、别处处理完申请（PAIR_REQUESTS_CHANGED_EVENT）。读走单飞
// （lib/coalescedReader.ts）：信号只会让在路上的那次读完再读一次，不会把它作废 —— 否则网络一慢，每个读回来的结果都
// 已被下一轮轮询作废，名单永远不动。作废只在本页处理掉一张申请时（dropPairRequest）：那之前发出的读会把它带回来。
// 读失败、超时就等下一次信号，轮询保证下一次一定会来。
//
// 每读成一次都告诉订阅方一遍，哪怕名单没变：通知那边靠它重试上一次没弹出去的。名单带着读回的时刻，用的人自己判断
// 它还新不新鲜。
import type { PairRequestView } from "@navi/shared";
import { authApi } from "./authApi.ts";
import { coalescedReader, type CoalescedReader } from "./coalescedReader.ts";
import { subscribeConnection, subscribeEvents } from "./events.ts";
import { PAIR_REQUESTS_CHANGED_EVENT } from "./pairing.ts";

const POLL_MS = 4_000;

export interface PairRequestsSnapshot {
  requests: PairRequestView[];
  /** 读回（或本页改动）的时刻。 */
  at: number;
}

type Listener = (requests: PairRequestView[]) => void;

const listeners = new Set<Listener>();
let current: PairRequestsSnapshot | null = null;
let reader: CoalescedReader | null = null;
let stopWatching: (() => void) | null = null;

function publish(requests: PairRequestView[]): void {
  current = { requests, at: Date.now() };
  for (const listener of listeners) listener(requests);
}

function watch(): () => void {
  const own = coalescedReader(() => authApi.pairRequests(), ({ requests }) => publish(requests));
  reader = own;
  const onReload = () => own.reload();
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
    own.close();
    reader = null;
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
  if (current) listener(current.requests);
  stopWatching ??= watch();
  reader?.reload();
  return () => {
    listeners.delete(listener);
    if (listeners.size || !stopWatching) return;
    stopWatching();
    stopWatching = null;
    current = null;
  };
}

/** 此刻最新的名单（还没读到过是 null）。 */
export function pairRequestsNow(): PairRequestsSnapshot | null {
  return current;
}

/** 这一张刚在本页处理掉：先从名单里拿掉，之前发出、还没回来的读作废（回来的是旧的），读完再读一次。 */
export function dropPairRequest(id: string): void {
  reader?.invalidate();
  if (current) publish(current.requests.filter((request) => request.id !== id));
}
