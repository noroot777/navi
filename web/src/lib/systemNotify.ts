// 系统通知的客户端那一半。什么时候弹、弹什么字由服务端定（server/src/system-notify.ts，SSE 上的 task.notify），
// 这里只管弹出来、点了回到那个任务。
//
// 弹到哪儿：
//   · mac app：交给原生（desktop/macos/Sources/SystemNotifications.swift）—— WKWebView 里没有网页通知。默认开着。
//   · 浏览器：网页通知（Notification），要这台设备上自己打开过、浏览器也给了权限。只在 https 或本机地址下有。
// 开关记在这台设备上（权限本来就是按设备给的），设置页「通知」那一块改它。
//
// 正对着看的那个任务不弹：窗口在前台、地址栏就是它，弹了只是噪音。几个页面各收到一份时靠 key 合成一条
// （浏览器按 tag、mac 按通知 id 替换）。
import type { ServerEvent } from "@navi/shared";
import { subscribeEvents } from "./events.ts";
import { safeStorage } from "./safeStorage.ts";

type Notice = Extract<ServerEvent, { type: "task.notify" }>;
interface NativeMessage { title: string; subtitle: string; body: string; key: string; project: string | null; task: string | null }
type NativeWindow = Window & { webkit?: { messageHandlers?: { naviNotify?: { postMessage: (message: NativeMessage) => void } } } };

const PREF_KEY = "navi:system-notify";
const listeners = new Set<() => void>();

function nativeBridge() {
  return (window as NativeWindow).webkit?.messageHandlers?.naviNotify ?? null;
}

export type NotifyChannel = "native" | "browser" | "none";

/** 这里能弹到哪儿。浏览器在非安全来源（http 的局域网地址）下没有 Notification。 */
export function notifyChannel(): NotifyChannel {
  if (nativeBridge()) return "native";
  return typeof Notification !== "undefined" && window.isSecureContext ? "browser" : "none";
}

/** 浏览器拒过权限：只能去浏览器的网站设置里改，页面再请求也不会弹框。 */
export function notifyBlocked(): boolean {
  return notifyChannel() === "browser" && Notification.permission === "denied";
}

export function systemNotifyEnabled(): boolean {
  const channel = notifyChannel();
  if (channel === "none") return false;
  const stored = safeStorage.get(PREF_KEY);
  if (channel === "native") return stored !== "off";
  return stored === "on" && Notification.permission === "granted";
}

/** 打开 / 关上。浏览器里打开要先拿到权限，拿不到就还是关着（返回实际结果）。 */
export async function setSystemNotifyEnabled(next: boolean): Promise<boolean> {
  if (next && notifyChannel() === "browser" && Notification.permission !== "granted") {
    await Notification.requestPermission().catch(() => "denied");
  }
  safeStorage.set(PREF_KEY, next ? "on" : "off");
  for (const listener of listeners) listener();
  return systemNotifyEnabled();
}

export function onSystemNotifyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function lookingAt(notice: Notice): boolean {
  if (!notice.taskId || document.visibilityState !== "visible" || !document.hasFocus()) return false;
  return new URLSearchParams(window.location.search).get("task") === notice.taskId;
}

/** 点了通知：回到那个任务（同 navi:// 链接落地那样推一条历史、发一次 popstate，不重载）。 */
export function openNoticeTarget(projectId: string | null, taskId: string | null): void {
  window.focus();
  if (!projectId) return;
  const params = new URLSearchParams({ project: projectId, ...(taskId ? { task: taskId } : {}) });
  window.history.pushState(null, "", `/?${params.toString()}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function show(notice: Notice): void {
  const bridge = nativeBridge();
  if (bridge) {
    bridge.postMessage({
      title: notice.title, subtitle: notice.subtitle, body: notice.body, key: notice.key,
      project: notice.projectId, task: notice.taskId,
    });
    return;
  }
  const body = notice.subtitle ? `${notice.body}\n${notice.subtitle}` : notice.body;
  const shown = new Notification(notice.title, { body, tag: notice.key });
  shown.onclick = () => {
    openNoticeTarget(notice.projectId, notice.taskId);
    shown.close();
  };
}

/** 整个页面听一份（App 里挂一次）。返回退订。 */
export function startSystemNotify(): () => void {
  return subscribeEvents((event) => {
    if (event.type !== "task.notify" || !systemNotifyEnabled() || lookingAt(event)) return;
    try {
      show(event);
    } catch {
      // 系统那边不收（权限中途被收回、原生桥这一下不在）：这一条就不弹了，侧栏照样标着。
    }
  });
}
