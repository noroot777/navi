// 运行日志的格式与脱敏规则：服务端、页面、mac 壳（desktop/macos/Sources/RuntimeLog.swift 照同一份格式）
// 往同一个目录里写 JSONL，`npm run diagnose` 把几份对齐成一条时间线，找出「窗口闪一下重载」那一刻
// 到底是谁出了事。
//
// 这份日志会被用户导出来发给别人看，所以**只记运行状况，不记任务内容**：没有标题、正文、提示词、
// 文件名、项目路径、URL 查询串，也没有任意的报错原文。做法是白名单：每个事件能带哪几个字段、
// 每个字段是什么形状，都在下面写死；进不了白名单的东西一律丢掉，而不是「见到敏感的再补过滤」。
//
// 「白名单」指的是**取值本身**来自固定集合，不是「长得像安全的」：报错原文只输出下面那张固定模板表里的
// 一句、错误名和错误码只认名单、路由只认服务端注册过的路由模板、页面报上来的栈帧位置要在磁盘上真有那个
// 代码文件。第 1 轮审查实测过按形状认的版本会漏：原生 `JSON.parse` 报错把数据的字段名带在引号里，
// 嵌套引号一错位就漏出来；`/tasks/abc123/page/token123/customer` 这样的动态段也长得像路由常量。

export type RuntimeLogSource = "server" | "web" | "mac" | "win";

/** 一行日志。`ev` 是事件名，其余字段按事件定（见各写入端）。 */
export type RuntimeLogRecord = {
  /** ISO 时间。 */
  at: string;
  src: RuntimeLogSource;
  pid?: number;
  ev: string;
  [field: string]: unknown;
};

/** 导出包的格式号：分析端按它认文件。 */
export const RUNTIME_LOG_BUNDLE_FORMAT = "navi-runtime-log";

export type RuntimeLogBundle = {
  format: typeof RUNTIME_LOG_BUNDLE_FORMAT;
  version: 1;
  exportedAt: string;
  host: { platform: string; arch: string; node: string; osRelease: string; cpus: number; memoryMB: number };
  records: RuntimeLogRecord[];
  exits: Array<Record<string, unknown>>;
};

/** 页面能报的事件。服务端只收这几个，字段再按 `sanitizeWebEvent` 过一遍。 */
export const WEB_RUNTIME_EVENTS = [
  "page.boot", "page.error", "page.crash", "page.reload", "events.down", "events.up",
] as const;
export type WebRuntimeEvent = (typeof WEB_RUNTIME_EVENTS)[number];

/** 页面整页重载是谁发起的（`page.reload.reason`）。 */
export const WEB_RELOAD_REASONS = ["identity", "account", "remote-access", "error-screen", "load-failure", "reclaim"] as const;

const NAV_TYPES = ["navigate", "reload", "back_forward", "prerender"] as const;
const SHELLS = ["mac", "win", "browser"] as const;
const ERROR_KINDS = ["error", "rejection"] as const;

/**
 * 报错原文**一个字都不进日志**，只看它是不是下面哪一类引擎报错，是就记那一类的固定说法。引擎报错的原文
 * 也会带数据（`JSON.parse` 把出错位置附近的原文放在引号里、`x.foo is not a function` 带着属性名），
 * 抹引号、抹路径都抹不干净，所以干脆不留原文，只留「是哪一类」。
 */
const ERROR_TEMPLATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Cannot read propert(?:y|ies) of (?:undefined|null)/, "Cannot read properties of undefined/null"],
  [/^Cannot set propert(?:y|ies) of (?:undefined|null)/, "Cannot set properties of undefined/null"],
  [/undefined is not an object|null is not an object/, "Cannot read properties of undefined/null"],
  [/is not a function/, "x is not a function"],
  [/is not a constructor/, "x is not a constructor"],
  [/is not iterable/, "x is not iterable"],
  [/is not defined$/, "x is not defined"],
  [/before initialization/, "Cannot access x before initialization"],
  [/Assignment to constant variable/, "Assignment to constant variable"],
  [/is not valid JSON|Unexpected token|Unexpected end of JSON|after JSON at position|JSON Parse error|JSON\.parse/, "JSON parse error"],
  [/Maximum call stack size exceeded/, "Maximum call stack size exceeded"],
  [/Invalid (?:array|string|typed array) length/, "Invalid length"],
  [/Converting circular structure to JSON/, "Converting circular structure to JSON"],
  [/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/, "Failed to load module"],
  [/Load failed|Failed to fetch|NetworkError/, "Failed to fetch"],
  [/out of memory/i, "Out of memory"],
];

/** 报错原文换成固定说法（见 ERROR_TEMPLATES）；认不出是哪一类就不记。 */
export function scrubErrorMessage(_name: string | undefined, message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  return ERROR_TEMPLATES.find(([pattern]) => pattern.test(message))?.[1];
}

/** 固定说法反查：页面报上来的 msg 必须正好是表里的一句。 */
const ERROR_TEMPLATE_TEXTS = new Set(ERROR_TEMPLATES.map(([, text]) => text));

/**
 * 错误名只认名单（引擎自带的、Node/浏览器常见的、navi 代码里会抛的几类）。名单外的一律记成 `OtherError`：
 * 业务代码里 `error.name = ...` 写什么都有可能。
 */
const ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError",
  "AbortError", "TimeoutError", "NetworkError", "DOMException", "SecurityError", "NotAllowedError", "QuotaExceededError",
  "ChunkLoadError", "SystemError", "SqliteError", "ApiError", "AuthError", "AssertionError",
]);

export function scrubErrorName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return undefined;
  return ERROR_NAMES.has(name) ? name : "OtherError";
}

/** 错误码只认系统 / Node / SQLite 那几种常量（`ENOENT`、`ERR_STREAM_DESTROYED`、`SQLITE_BUSY`）和整数。 */
export function scrubErrorCode(code: unknown): string | undefined {
  if (typeof code === "number" && Number.isInteger(code)) return String(code);
  return typeof code === "string" && /^(?:E[A-Z0-9]{2,20}|ERR_[A-Z0-9_]{2,60}|SQLITE_[A-Z_]{2,40})$/.test(code) ? code : undefined;
}

/**
 * 调用栈的一帧压成「函数名 位置」，位置只留代码里的相对位置：
 *   · navi 自己的代码 → 相对代码根的路径:行号（`server/dist/reattach.js:120`、`assets/index-abc.js:1`）
 *   · Node 内置 → `node:child_process`
 *   · 依赖 → `node_modules/<包名>`
 *   · 其它（用户项目里的文件、eval、匿名）→ `<other>`
 * 函数名只认标识符形状，别的抹成 `<anon>`。
 */
export function scrubFrame(functionName: string | undefined, url: string | undefined, line: number | undefined, codeRoots: readonly string[]): string {
  const fn = functionName && /^[\w$.<> \[\]-]{1,80}$/.test(functionName) ? functionName : "<anon>";
  return `${fn} ${scrubLocation(url, line, codeRoots)}`;
}

function scrubLocation(url: string | undefined, line: number | undefined, codeRoots: readonly string[]): string {
  if (!url) return "<native>";
  if (url.startsWith("node:")) return url.split(/[?#]/)[0]!.slice(0, 60);
  // 页面那一侧的代码根是 origin（`http://localhost:4317`），同源的脚本按 origin 之后那段算。
  for (const root of codeRoots) {
    if (/^https?:\/\//.test(root) && url.startsWith(`${root}/`)) {
      const rel = url.slice(root.length + 1).split(/[?#]/)[0]!;
      return /^[\w./@-]{1,160}$/.test(rel) ? `${rel}${typeof line === "number" ? `:${line}` : ""}` : "<other>";
    }
  }
  let path = url;
  try {
    if (/^[a-z]+:\/\//i.test(url)) path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return "<other>";
  }
  path = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const modules = path.lastIndexOf("/node_modules/");
  if (modules >= 0) {
    const rest = path.slice(modules + "/node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
    return name && /^[@\w./-]{1,80}$/.test(name) ? `node_modules/${name}` : "node_modules";
  }
  for (const root of codeRoots) {
    const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized && path.startsWith(`${normalized}/`)) {
      const rel = path.slice(normalized.length + 1);
      if (/^[\w./@-]{1,160}$/.test(rel)) return `${rel}${typeof line === "number" ? `:${line}` : ""}`;
    }
  }
  return "<other>";
}

/** 解析 `Error.stack` 文本（V8 与 JavaScriptCore 两种格式），逐帧压成 `scrubFrame` 的样子，最多 `limit` 帧。 */
export function scrubStack(stack: unknown, codeRoots: readonly string[], limit = 8): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    // V8：`at fn (url:line:col)` / `at url:line:col`
    let match = /^at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
    // JavaScriptCore / Firefox：`fn@url:line:col`
    if (!match) {
      const jsc = /^(.*?)@(.+?):(\d+):\d+$/.exec(line);
      if (jsc) match = [jsc[0], jsc[1] || undefined, jsc[2], jsc[3]] as unknown as RegExpExecArray;
    }
    if (!match) continue;
    frames.push(scrubFrame(match[1], match[2], Number(match[3]), codeRoots));
    if (frames.length >= limit) break;
  }
  return frames;
}

/**
 * 服务端注册的路由模板（Hono 的 `c.req.routePath`，如 `/api/tasks/:id/messages`）。它来自代码里写死的
 * 注册表，不是请求路径，所以任务号、文件名进不来；这里只再认一遍字符，防一个意外的注册写法。
 */
export function routePattern(registered: unknown): string {
  return typeof registered === "string" && /^[\w/:*.?-]{1,120}$/.test(registered) ? registered : "?";
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function count(value: unknown, max = 86_400_000): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), max) : undefined;
}

/**
 * 页面报上来的栈帧：位置要么是 `isCodeFile` 认得的代码文件（服务端拿磁盘上的 web 产物核对），要么换成
 * `<native>`/`<other>` 且函数名抹成 `<anon>`——不是原样留下。
 */
function frames(value: unknown, isCodeFile: (rel: string) => boolean): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: string[] = [];
  for (const frame of value.slice(0, 8)) {
    if (typeof frame !== "string") continue;
    const match = /^([A-Za-z_$<][\w$.<>]{0,60}) (\S{1,200})$/.exec(frame);
    if (!match) continue;
    const [, fn, location] = match;
    const file = /^([\w./-]+\.(?:js|mjs|ts|tsx)):\d+$/.exec(location!)?.[1];
    // 函数名跟着位置走：位置核对成 navi 的代码文件，名字才是代码里的标识符；否则一并抹掉。
    if (file && isCodeFile(file)) kept.push(`${fn} ${location}`);
    else kept.push(`<anon> ${location === "<native>" ? "<native>" : "<other>"}`);
  }
  return kept;
}

/**
 * 页面报上来的一条，按事件名只留白名单字段。认不出的事件返回 null。
 * 这是**服务端**的那道闸：页面那一侧也会先压一遍，但不能指望它。
 */
export function sanitizeWebEvent(
  input: unknown,
  isCodeFile: (rel: string) => boolean = () => false,
): Omit<RuntimeLogRecord, "at" | "src" | "pid"> | null {
  if (!input || typeof input !== "object") return null;
  const event = input as Record<string, unknown>;
  const ev = pick(event.ev, WEB_RUNTIME_EVENTS);
  if (!ev) return null;
  const out: Record<string, unknown> = { ev };
  const set = (key: string, value: unknown) => { if (value !== undefined) out[key] = value; };
  set("tab", typeof event.tab === "string" && /^[A-Za-z0-9]{4,16}$/.test(event.tab) ? event.tab : undefined);
  set("shell", pick(event.shell, SHELLS));
  // 事件发生在发出之前多久（页面攒一批再发）：服务端拿它把时间拨回发生那一刻。
  set("ago", count(event.ago, 10 * 60_000));
  switch (ev) {
    case "page.boot":
      set("nav", pick(event.nav, NAV_TYPES));
      set("hidden", typeof event.hidden === "boolean" ? event.hidden : undefined);
      set("sincePrevMs", count(event.sincePrevMs));
      break;
    case "page.error":
    case "page.crash": {
      const name = scrubErrorName(event.name);
      set("kind", pick(event.kind, ERROR_KINDS));
      set("name", name);
      set("msg", typeof event.msg === "string" && ERROR_TEMPLATE_TEXTS.has(event.msg) ? event.msg : undefined);
      set("frames", frames(event.frames, isCodeFile));
      break;
    }
    case "page.reload":
      set("reason", pick(event.reason, WEB_RELOAD_REASONS));
      break;
    case "events.down":
      break;
    case "events.up":
      set("downMs", count(event.downMs));
      break;
  }
  return out as Omit<RuntimeLogRecord, "at" | "src" | "pid">;
}

// ── 分析结果（server/src/runtime-log/analyze.ts 产出，设置页与 `npm run diagnose` 展示）──

export type CauseKind =
  | "sleep" | "restart" | "stall" | "webcontent" | "page_error" | "reload" | "not_ours" | "refused_connection" | "unknown";

export type Incident = {
  at: string;
  cause: CauseKind;
  /** 一句话结论。 */
  summary: string;
  /** 证据，一行一条。 */
  evidence: string[];
  /** 这一次前后的相关记录（时间线）。 */
  timeline: RuntimeLogRecord[];
};

export type StackTally = { frame: string; stalls: number; ms: number };

export type RuntimeLogReport = {
  from: string | null;
  to: string | null;
  counts: Record<string, number>;
  incidents: Incident[];
  causes: Partial<Record<CauseKind, number>>;
  stalls: { total: number; overOneAndHalf: number; maxMs: number; medianMs: number; cpuBound: number; waiting: number };
  /** 卡顿时最常出现的 navi 代码位置（按卡顿总时长排）。 */
  hotspots: StackTally[];
  restarts: Array<{ at: string; how: string }>;
  errors: Array<{ src: string; name: string; count: number; last: string }>;
  notes: string[];
};

export const CAUSE_LABELS: Record<CauseKind, string> = {
  sleep: "电脑睡眠唤醒",
  restart: "服务重启",
  stall: "服务卡住",
  webcontent: "网页进程被结束",
  page_error: "页面脚本出错",
  reload: "整页刷新",
  not_ours: "端口被占",
  refused_connection: "连接被拒",
  unknown: "原因不明",
};
