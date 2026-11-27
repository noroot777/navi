import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "@navi/shared";
import { reportEventsConnection } from "./runtimeLog.ts";

type EventListener = (event: ServerEvent) => void;
type ConnectionListener = (connected: boolean) => void;

const eventListeners = new Set<EventListener>();
const connectionListeners = new Set<ConnectionListener>();
let eventSource: EventSource | null = null;
let connected = false;
/**
 * 服务端每 15 秒推一次 ping（server/src/routes.ts 的 /api/events）。服务卡住时连接不断、也不报错，
 * EventSource 自己永远发现不了 —— 页面只能从「好久没收到东西」看出来：报断开、换一条连接重连，
 * 新连接答上来（onopen）就算恢复。卡多久都只是等，不撤页面（mac 壳也一样，见 BrowserWindowController）。
 */
const STALE_AFTER_MS = 40_000;
let lastHeard = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

function publishConnection(next: boolean) {
  connected = next;
  reportEventsConnection(next);
  for (const listener of connectionListeners) listener(next);
}

function heard() {
  lastHeard = Date.now();
}

function openEventSource() {
  heard();
  eventSource = new EventSource("/api/events");
  eventSource.onopen = () => {
    heard();
    publishConnection(true);
  };
  eventSource.onerror = () => publishConnection(false);
  eventSource.addEventListener("ping", heard);
  eventSource.onmessage = (message) => {
    heard();
    try {
      const event = JSON.parse(message.data) as ServerEvent;
      for (const listener of eventListeners) listener(event);
    } catch {
      // 非 JSON 消息无需进入应用状态。
    }
  };
}

function ensureConnection() {
  if (eventSource) return;
  openEventSource();
  watchdog = setInterval(() => {
    if (!eventSource || Date.now() - lastHeard < STALE_AFTER_MS) return;
    // 系统睡眠醒来时也会走到这里：那条连接多半已经死了，重连一次正好。
    eventSource.close();
    publishConnection(false);
    openEventSource();
  }, 5_000);
}

function releaseConnection() {
  if (eventListeners.size || connectionListeners.size || !eventSource) return;
  eventSource.close();
  eventSource = null;
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
  connected = false;
}

/** 不在组件里的订阅方（模块级的缓存）用这个；组件里用 useServerEvents。 */
export function subscribeEvents(listener: EventListener) {
  eventListeners.add(listener);
  ensureConnection();
  return () => {
    eventListeners.delete(listener);
    releaseConnection();
  };
}

/** 同上：连接断开 / 连上。订上那一刻先报一次当前状态。 */
export function subscribeConnection(listener: ConnectionListener) {
  connectionListeners.add(listener);
  listener(connected);
  ensureConnection();
  return () => {
    connectionListeners.delete(listener);
    releaseConnection();
  };
}

/**
 * 全应用共享一条 EventSource；多个数据 hook 只增加本地订阅者。`enabled` = false 时不订（也就不会
 * 为它开那条连接），报「没连上」——给那种同一个 hook 有时只读快照、不该听本机事件的调用方。
 */
export function useServerEvents(onEvent: EventListener, enabled = true): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [isConnected, setIsConnected] = useState(connected);

  useEffect(() => {
    if (!enabled) return;
    const removeEvent = subscribeEvents((event) => handler.current(event));
    const removeConnection = subscribeConnection(setIsConnected);
    return () => {
      removeEvent();
      removeConnection();
    };
  }, [enabled]);

  return enabled && isConnected;
}
