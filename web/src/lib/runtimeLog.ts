// 页面这一侧的运行日志（格式与脱敏见 @navi/shared/runtime-log，分析见 server/src/runtime-log/analyze.ts）。
//
// 只报这页自己知道、服务端和壳都看不见的几件事：这一页是怎么载进来的（正常打开 / 整页重载 / 前进后退），
// 页面主动整页重载的原因，没人接住的脚本报错，和事件流断开了多久。报错只带名字、报错类别的固定说法
// 和栈上的代码位置，原文和页面内容一个字都不带（服务端收的时候再按同一份白名单核一遍）。
//
// 攒一小批再发；整页重载之前那一条要用 keepalive，否则页面一走请求就被掐掉了。一次最多发 `WEB_EVENTS_PER_POST`
// 条（服务端一次就收这么多），多了分几次发，崩溃、重载、载入这几条状态排在最前；详情攒太多就不再攒，
// 状态一条不丢。
import {
  WEB_EVENTS_PER_POST, WEB_STATE_EVENTS, scrubErrorMessage, scrubErrorName, scrubStack, type WEB_RELOAD_REASONS, type WebRuntimeEvent,
} from "@navi/shared/runtime-log";
import { apiPath } from "./apiClient.ts";

type Event = { ev: WebRuntimeEvent; [field: string]: unknown };
/** `t`：事件发生的时刻。发出时换算成「多久之前」（`ago`），服务端按它把时间拨回去 —— 页面攒一批再发，收到时刻会晚。 */
type Pending = { event: Event; t: number };

const FLUSH_MS = 3000;
/** 攒着没发的详情（报错、断线）最多这么多：服务一直连不上时不能无限攒。 */
const MAX_PENDING_DETAILS = 100;
/**
 * 一页最多报几条普通报错（`page.error`）：一个坏组件每帧抛一次时，日志不能跟着刷屏。
 * 整页崩溃（`page.crash`）是状态变化不是详情，不占这份额度：一次载入只会崩一次，前面报错再多它也要记下。
 */
const MAX_ERRORS = 10;
const TAB_KEY = "navi.runtimeLog.tab";
const BOOT_KEY = "navi.runtimeLog.lastBoot";
/** 这个标签页上一次载入的标识：新载入的这一页报 `prev`，分析端拿它把「上一页怎么没的」和「这一页」对成同一次。 */
const LOAD_KEY = "navi.runtimeLog.load";

const pending: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let errorsSent = 0;
/** 因为上限没报的详情（报错超过 MAX_ERRORS、攒着没发的超过 MAX_PENDING_DETAILS）：下一批里带上个数。 */
let skipped = 0;
const seenErrors = new Set<string>();
let crashReported = false;

const shell = /\b(?:Navi|Ash)Mac\//.test(navigator.userAgent) ? "mac" : /\bNaviWin\//.test(navigator.userAgent) ? "win" : "browser";
// 页面的代码位置按 origin 算相对路径（`assets/index-abc.js:1`）。
const codeRoots = [location.origin];

const randomId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

function tabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem(TAB_KEY, created);
    return created;
  } catch {
    return "nostore";
  }
}

const tab = tabId();
/** 这一次载入：每次载入新起一个，这一页上报的每一条都带着它。 */
const load = randomId();

const isState = (pending: Pending) => WEB_STATE_EVENTS.includes(pending.event.ev);

function send(events: Pending[], keepalive: boolean): void {
  if (skipped) {
    events.push({ event: { ev: "page.skipped", count: skipped }, t: Date.now() });
    skipped = 0;
  }
  if (!events.length) return;
  const ordered = [...events.filter(isState), ...events.filter((pending) => !isState(pending))];
  for (let start = 0; start < ordered.length; start += WEB_EVENTS_PER_POST) post(ordered.slice(start, start + WEB_EVENTS_PER_POST), keepalive);
}

function post(events: Pending[], keepalive: boolean): void {
  void fetch(apiPath("/runtime-log/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: events.map(({ event, t }) => ({ ...event, tab, load, shell, ago: Math.max(0, Date.now() - t) })) }),
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

function queue(event: Event): void {
  const next = { event, t: Date.now() };
  if (!isState(next) && pending.filter((item) => !isState(item)).length >= MAX_PENDING_DETAILS) {
    skipped += 1;
    return;
  }
  pending.push(next);
  timer ??= setTimeout(() => flush(), FLUSH_MS);
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const name = scrubErrorName(error.name);
  return { name, msg: scrubErrorMessage(name, error.message), frames: scrubStack(error.stack, codeRoots) };
}

function reportError(kind: "error" | "rejection" | "boundary", error: unknown): void {
  if (errorsSent >= MAX_ERRORS) {
    skipped += 1;
    return;
  }
  const fields = errorFields(error);
  const key = `${String(fields.name)}:${String((fields.frames as string[] | undefined)?.[0] ?? "")}`;
  if (seenErrors.has(key)) return;
  seenErrors.add(key);
  errorsSent += 1;
  queue({ ev: "page.error", kind, ...fields });
}

/** 根上的错误边界接住了渲染报错（整页换成「页面没有正常显示」）。 */
export function reportPageCrash(error: unknown): void {
  if (crashReported) return;
  crashReported = true;
  queue({ ev: "page.crash", kind: "error", ...errorFields(error) });
  flush();
}

/** 页面里某一块（终端、Git 工作台）的错误边界接住了：那一块换成「加载失败」，整页还在，不算整页崩溃。 */
export function reportBoundaryError(error: unknown): void {
  reportError("boundary", error);
}

/** 页面要主动整页重载了：先把原因记下（keepalive 发出去），调用方随后 reload。 */
export function reportPageReload(reason: (typeof WEB_RELOAD_REASONS)[number]): void {
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
  let prev: string | undefined;
  try {
    const previous = Number(sessionStorage.getItem(BOOT_KEY));
    if (previous > 0) sincePrevMs = Date.now() - previous;
    prev = sessionStorage.getItem(LOAD_KEY) ?? undefined;
    sessionStorage.setItem(BOOT_KEY, String(Date.now()));
    sessionStorage.setItem(LOAD_KEY, load);
  } catch {
    /* 拿不到存储就不报间隔和上一次载入 */
  }
  queue({ ev: "page.boot", nav: navigation?.type, hidden: document.visibilityState === "hidden", sincePrevMs, prev });
  window.addEventListener("error", (event) => reportError("error", event.error));
  window.addEventListener("unhandledrejection", (event) => reportError("rejection", event.reason));
  window.addEventListener("pagehide", () => {
    leaving = true;
    flush(true);
  });
  // 从往返缓存里回来的同一页接着用。
  window.addEventListener("pageshow", () => { leaving = false; });
}

boot();
