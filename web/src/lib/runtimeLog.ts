// 页面这一侧的运行日志（格式与脱敏见 @navi/shared/runtime-log，分析见 server/src/runtime-log/analyze.ts）。
//
// 只报这页自己知道、服务端和壳都看不见的几件事：这一页是怎么载进来的（正常打开 / 整页重载 / 前进后退），
// 页面主动整页重载的原因，没人接住的脚本报错，和事件流断开了多久。报错只带名字、脱敏后的引擎原文和
// 栈上的代码位置，不带任何页面内容。
//
// 攒一小批再发；整页重载之前那一条要用 keepalive，否则页面一走请求就被掐掉了。
import { scrubErrorMessage, scrubErrorName, scrubStack, type WebRuntimeEvent } from "@navi/shared/runtime-log";
import { apiPath } from "./apiClient.ts";

type Pending = { ev: WebRuntimeEvent; [field: string]: unknown };

const FLUSH_MS = 3000;
/** 一页最多报几条报错：一个坏组件每帧抛一次时，日志不能跟着刷屏。 */
const MAX_ERRORS = 10;
const TAB_KEY = "navi.runtimeLog.tab";
const BOOT_KEY = "navi.runtimeLog.lastBoot";

const pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let errorsSent = 0;
const seenErrors = new Set<string>();

const shell = /\b(?:Navi|Ash)Mac\//.test(navigator.userAgent) ? "mac" : /\bNaviWin\//.test(navigator.userAgent) ? "win" : "browser";
// 页面的代码位置按 origin 算相对路径（`assets/index-abc.js:1`）。
const codeRoots = [location.origin];

function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(TAB_KEY, created);
    return created;
  } catch {
    return "nostore";
  }
}

const tab = tabId();

function send(events: Pending[], keepalive: boolean): void {
  if (!events.length) return;
  void fetch(apiPath("/runtime-log/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: events.map((event) => ({ ...event, tab, shell })) }),
    keepalive,
  }).catch(() => {
    /* 服务正好不在：这几条就丢了，日志本来就是尽力而为 */
  });
}

function flush(keepalive = false): void {
  if (timer) clearTimeout(timer);
  timer = null;
  send(pending.splice(0), keepalive);
}

function queue(event: Pending): void {
  pending.push(event);
  timer ??= setTimeout(() => flush(), FLUSH_MS);
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const name = scrubErrorName(error.name);
  return { name, msg: scrubErrorMessage(name, error.message), frames: scrubStack(error.stack, codeRoots) };
}

function reportError(ev: "page.error" | "page.crash", kind: "error" | "rejection", error: unknown): void {
  if (errorsSent >= MAX_ERRORS) return;
  const fields = errorFields(error);
  const key = `${ev}:${String(fields.name)}:${String((fields.frames as string[] | undefined)?.[0] ?? "")}`;
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  errorsSent += 1;
  queue({ ev, kind, ...fields });
}

/** 根上的错误边界接住了渲染报错（整页换成「页面没有正常显示」）。 */
export function reportPageCrash(error: unknown): void {
  reportError("page.crash", "error", error);
  flush();
}

/** 页面要主动整页重载了：先把原因记下（keepalive 发出去），调用方随后 reload。 */
export function reportPageReload(reason: "identity" | "account" | "remote-access" | "error-screen" | "reclaim"): void {
  queue({ ev: "page.reload", reason });
  flush(true);
}

let downSince: number | null = null;
/** 页面正在离开：浏览器这时会掐掉事件流，那不是断线。 */
let leaving = false;

/** 事件流（/api/events）断开 / 连上。只报断开过的那几次，连着的时候什么都不发。 */
export function reportEventsConnection(connected: boolean): void {
  if (leaving) return;
  if (!connected) {
    if (downSince === null) {
      downSince = performance.now();
      queue({ ev: "events.down" });
    }
    return;
  }
  if (downSince === null) return;
  queue({ ev: "events.up", downMs: Math.round(performance.now() - downSince) });
  downSince = null;
}

function boot(): void {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  let sincePrevMs: number | undefined;
  try {
    const previous = Number(sessionStorage.getItem(BOOT_KEY));
    if (previous > 0) sincePrevMs = Date.now() - previous;
    sessionStorage.setItem(BOOT_KEY, String(Date.now()));
  } catch {
    /* 拿不到存储就不报间隔 */
  }
  queue({ ev: "page.boot", nav: navigation?.type, hidden: document.visibilityState === "hidden", sincePrevMs });
  window.addEventListener("error", (event) => reportError("page.error", "error", event.error));
  window.addEventListener("unhandledrejection", (event) => reportError("page.error", "rejection", event.reason));
  window.addEventListener("pagehide", () => {
    leaving = true;
    flush(true);
  });
  // 从往返缓存里回来的同一页接着用。
  window.addEventListener("pageshow", () => { leaving = false; });
}

boot();
