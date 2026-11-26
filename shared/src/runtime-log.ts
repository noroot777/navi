// 运行日志的格式与脱敏规则：服务端、页面、mac 壳（desktop/macos/Sources/RuntimeLog.swift 照同一份格式）
// 往同一个目录里写 JSONL，`npm run diagnose` 把几份对齐成一条时间线，找出「窗口闪一下重载」那一刻
// 到底是谁出了事。
//
// 这份日志会被用户导出来发给别人看，所以**只记运行状况，不记任务内容**：没有标题、正文、提示词、
// 文件名、项目路径、URL 查询串，也没有任意的报错原文。做法是白名单：每个事件能带哪几个字段、
// 每个字段是什么形状，都在下面写死；进不了白名单的东西一律丢掉，而不是「见到敏感的再补过滤」。
//
// 「白名单」指的是**取值本身**来自固定集合或能核对出处，不是「长得像安全的」：
//   · 报错原文只输出下面那张固定模板表里的一句；错误名、错误码、系统调用名、HTTP 方法只认名单；
//   · 路由只认服务端注册过的路由模板；
//   · 栈帧只存磁盘上真有的 navi 代码位置（`verifyFrames`），**不存函数名**——上报的名字可以是运行时拼出来的、
//     页面随便填的，怎么核都证明不了它来自代码；只有 Node 内置模块的公开导出名这一份封闭名单带名字；
//   · 页面生成的标识（标签页、这一次载入）服务端收下时换成摘要，页面塞什么都只剩一串散列。
// 前两轮审查实测过按形状认的版本会漏：原生 `JSON.parse` 报错把数据的字段名带在引号里；
// `/tasks/abc123/page/token123/customer` 这样的动态段长得像路由常量；`CustomerAcquisitionBudget` 长得
// 像函数名、旁边的文件也真的存在；`OpenAI` 在打包产物的界面文案里出现过；`ERR_CUSTOMER_ACQUISITION`
// 长得像 Node 的错误码。

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

/**
 * 每一行带的格式号（`v`）。写入端的规则收紧过一次就加一：读的一侧（server/src/runtime-log/project.ts）
 * 对读回来时核对不了的字段（路由模板），只信带着当前号的那些行。
 */
export const RUNTIME_LOG_SCHEMA = 2;

export type RuntimeLogBundle = {
  format: typeof RUNTIME_LOG_BUNDLE_FORMAT;
  /** 2：records 和 exits 是导出时按当前规则重新投影过的；1：更早的版本导出的，原样写盘的内容。 */
  version: 1 | 2;
  exportedAt: string;
  host: { platform: string; arch: string; node: string; osRelease: string; cpus: number; memoryMB: number };
  records: RuntimeLogRecord[];
  exits: Array<Record<string, unknown>>;
};

/** 页面能报的事件。服务端只收这几个，字段再按 `sanitizeWebEvent` 过一遍。 */
export const WEB_RUNTIME_EVENTS = [
  "page.boot", "page.error", "page.crash", "page.reload", "events.down", "events.up", "page.skipped",
] as const;
export type WebRuntimeEvent = (typeof WEB_RUNTIME_EVENTS)[number];

/** 页面整页重载是谁发起的（`page.reload.reason`）。 */
export const WEB_RELOAD_REASONS = ["identity", "account", "remote-access", "error-screen", "load-failure", "reclaim"] as const;

export const NAV_TYPES = ["navigate", "reload", "back_forward", "prerender"] as const;
export const SHELLS = ["mac", "win", "browser"] as const;
/** `boundary`：页面里某一块的错误边界接住了（那一块换成了「加载失败」，整页还在）。 */
export const ERROR_KINDS = ["error", "rejection", "boundary"] as const;

/**
 * 页面一次最多发几条（页面按这个分批，服务端一次最多收这么多）。两边用同一个数：服务端不能在认出事件性质之前
 * 就把多出来的截掉，页面也不能一批塞得比服务端收的多。
 */
export const WEB_EVENTS_PER_POST = 20;
/** 页面那边的状态变化（不是详情）：分批时排在最前，服务端超额时也先收它们。 */
export const WEB_STATE_EVENTS: readonly WebRuntimeEvent[] = ["page.crash", "page.reload", "page.boot"];

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

/** 固定说法反查：页面报上来的 msg、读回来的旧记录里的 msg 必须正好是表里的一句。 */
const ERROR_TEMPLATE_TEXTS = new Set(ERROR_TEMPLATES.map(([, text]) => text));

export function isErrorTemplate(msg: unknown): msg is string {
  return typeof msg === "string" && ERROR_TEMPLATE_TEXTS.has(msg);
}

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

// 错误码名单：POSIX/libuv 的 errno、Node 自己的 ERR_*（服务端会遇到的那些）、undici、SQLite 的主结果码。
const ERRNO_CODES = new Set(("E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EAFNOSUPPORT EAGAIN EAI_AGAIN EAI_FAIL EAI_NODATA EAI_NONAME "
  + "EAI_SERVICE EALREADY EBADF EBUSY ECANCELED ECHARSET ECHILD ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDESTADDRREQ "
  + "EDOM EDQUOT EEXIST EFAULT EFBIG EHOSTDOWN EHOSTUNREACH EILSEQ EINPROGRESS EINTR EINVAL EIO EISCONN EISDIR ELOOP EMFILE "
  + "EMLINK EMSGSIZE ENAMETOOLONG ENETDOWN ENETRESET ENETUNREACH ENFILE ENOBUFS ENODEV ENOENT ENOEXEC ENOMEM ENOSPC ENOSYS "
  + "ENOTCONN ENOTDIR ENOTEMPTY ENOTSOCK ENOTSUP ENOTTY ENXIO EOF EOPNOTSUPP EOVERFLOW EPERM EPIPE EPROTO EPROTONOSUPPORT "
  + "EPROTOTYPE ERANGE EROFS ESHUTDOWN ESPIPE ESRCH ESTALE ETIMEDOUT ETXTBSY EXDEV ABORT_ERR "
  + "ERR_ASSERTION ERR_BUFFER_TOO_LARGE ERR_CHILD_PROCESS_IPC_REQUIRED ERR_CHILD_PROCESS_STDIO_MAXBUFFER ERR_FS_FILE_TOO_LARGE "
  + "ERR_HTTP_HEADERS_SENT ERR_HTTP_INVALID_STATUS_CODE ERR_HTTP_REQUEST_TIMEOUT ERR_HTTP2_INVALID_SESSION ERR_HTTP2_STREAM_ERROR "
  + "ERR_IMPORT_ATTRIBUTE_MISSING ERR_INSPECTOR_ALREADY_CONNECTED ERR_INSPECTOR_NOT_AVAILABLE ERR_INVALID_ARG_TYPE "
  + "ERR_INVALID_ARG_VALUE ERR_INVALID_RETURN_VALUE ERR_INVALID_STATE ERR_INVALID_THIS ERR_INVALID_URL ERR_IPC_CHANNEL_CLOSED "
  + "ERR_IPC_DISCONNECTED ERR_METHOD_NOT_IMPLEMENTED ERR_MODULE_NOT_FOUND ERR_MULTIPLE_CALLBACK ERR_OUT_OF_RANGE "
  + "ERR_PACKAGE_PATH_NOT_EXPORTED ERR_REQUIRE_ESM ERR_SERVER_ALREADY_LISTEN ERR_SERVER_NOT_RUNNING ERR_SOCKET_CLOSED "
  + "ERR_SOCKET_CONNECTION_TIMEOUT ERR_SQLITE_ERROR ERR_STREAM_ALREADY_FINISHED ERR_STREAM_CANNOT_PIPE ERR_STREAM_DESTROYED "
  + "ERR_STREAM_PREMATURE_CLOSE ERR_STREAM_PUSH_AFTER_EOF ERR_STREAM_WRITE_AFTER_END ERR_STRING_TOO_LONG ERR_SYSTEM_ERROR "
  + "ERR_TLS_CERT_ALTNAME_INVALID ERR_SSL_WRONG_VERSION_NUMBER ERR_UNHANDLED_ERROR ERR_UNHANDLED_REJECTION "
  + "ERR_UNKNOWN_FILE_EXTENSION ERR_USE_AFTER_CLOSE ERR_WORKER_OUT_OF_MEMORY "
  + "UND_ERR_ABORTED UND_ERR_BODY_TIMEOUT UND_ERR_CLOSED UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_SOCKET").split(" "));
const SQLITE_CODES = ("ERROR INTERNAL PERM ABORT BUSY LOCKED NOMEM READONLY INTERRUPT IOERR CORRUPT NOTFOUND FULL CANTOPEN "
  + "PROTOCOL EMPTY SCHEMA TOOBIG CONSTRAINT MISMATCH MISUSE NOLFS AUTH FORMAT RANGE NOTADB NOTICE WARNING").split(" ");

/**
 * 错误码：名单里的原样留；SQLite 的扩展码（`SQLITE_BUSY_SNAPSHOT`）记它的主结果码；整数照留；
 * 别的字符串一律记成 `OTHER`——知道「有个码」，不知道是什么。
 */
export function scrubErrorCode(code: unknown): string | undefined {
  if (typeof code === "number" && Number.isInteger(code)) return String(code);
  if (typeof code !== "string" || !code) return undefined;
  // 整数码记下来就是十进制串：读回来再过一遍要还是它（读的一侧也调这个）。
  if (/^-?\d{1,12}$/.test(code)) return code;
  if (ERRNO_CODES.has(code)) return code;
  const sqlite = SQLITE_CODES.find((primary) => code === `SQLITE_${primary}` || code.startsWith(`SQLITE_${primary}_`));
  return sqlite ? `SQLITE_${sqlite}` : "OTHER";
}

const SYSCALLS = new Set(("open close read write stat lstat fstat access unlink rename mkdir mkdtemp rmdir rm scandir readdir "
  + "opendir readlink realpath symlink link chmod chown utime futime fsync fdatasync ftruncate copyfile cp watch spawn "
  + "spawnSync kill connect listen bind accept shutdown getaddrinfo getnameinfo uv_cwd uv_os_homedir uv_os_get_passwd").split(" "));

/** 系统调用名只认名单。 */
export function scrubSyscall(syscall: unknown): string | undefined {
  return typeof syscall === "string" && SYSCALLS.has(syscall) ? syscall : undefined;
}

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** HTTP 方法是请求方写的，名单外的记成 `OTHER`。 */
export function scrubMethod(method: unknown): string {
  return typeof method === "string" && HTTP_METHODS.has(method) ? method : "OTHER";
}

/**
 * 调用栈的一帧压成「函数名 位置」的**候选**，位置只留代码里的相对位置：
 *   · navi 自己的代码 → 相对代码根的路径:行号（`server/dist/reattach.js:120`）；页面的打包产物再带列号
 *     （`assets/index-abc.js:1:900`，压缩过的产物只有一行，没有列号定位不了）
 *   · Node 内置 → `node:child_process`（内部模块一律 `node:internal`）
 *   · 依赖 → `node_modules/<包名>`
 *   · 其它（用户项目里的文件、eval、匿名）→ `<other>`
 * 候选只过了形状，**写进日志之前必须过 `verifyFrames`**：候选里的函数名不会原样留下。
 */
export function scrubFrame(
  functionName: string | undefined, url: string | undefined, line: number | undefined, codeRoots: readonly string[], column?: number,
): string {
  const fn = functionName && /^[\w$.<> \[\]-]{1,80}$/.test(functionName) ? functionName : "<anon>";
  return `${fn} ${scrubLocation(url, line, codeRoots, column)}`;
}

/** 栈帧出处：服务端按磁盘上的代码回答（server/src/runtime-log/code-symbols.ts）。 */
export type CodeLocations = {
  /**
   * 这个代码位置在不在，在就给出**核对过的那个位置本身**：`server/dist/x.js`、`assets/a.js`、`node:fs`、
   * `node_modules/hono`（位置去掉行列号）；不在、或者写法不是规范写法（带 `.` / `..` / 空段）就是 null。
   * 落盘只用这个返回值，不用上报的原串——原串里核对时被规范化掉的那几段（`src/客户名/../lib/x.ts`）什么都能装。
   */
  resolve(file: string): string | null;
  /** 这一帧能带的名字：只有 Node 内置模块、且 `reported` 是它公开导出的名字（封闭集合）；其余一律 null，只留位置。 */
  nameAt(file: string, line: number | null, reported: string): string | null;
};

/** 不是代码位置、本身就是固定写法的几帧：认不出的、原生的，和采样器给 V8 特殊节点起的名字（sampler.ts）。 */
const FIXED_FRAMES = new Set(["<native>", "<other>", "(gc)", "(program)", "(idle)"]);

/** 行列号：正整数，超过这么大的不是真代码里的位置。 */
const MAX_LINE_OR_COLUMN = 10_000_000;

/**
 * 栈帧候选过出处核对，输出代码位置（Node 内置模块的公开导出带名字）：
 *   · 位置不在 → `<other>`；输出的位置由核对结果（`resolve` 的返回值）和重新格式化的行列号拼成，不回写上报的原串；
 *   · 上报的函数名不留：它可以是运行时拼出来的（`{ [title]: () => {} }`、`Object.defineProperty(fn, "name", …)`），
 *     页面还能随便填；核对「这个词在代码文件里出现过」也挡不住（第 3 轮审查实测 `OpenAI` 就这样带了出去）。
 */
export function verifyFrames(frames: unknown, locations: CodeLocations, limit = 8): string[] {
  if (!Array.isArray(frames)) return [];
  const kept: string[] = [];
  for (const frame of frames.slice(0, limit)) {
    if (typeof frame !== "string" || frame.length > 300) continue;
    // 「名字 位置」或者只有位置；形状不对的（空位置、只有名字）当成认不出的一帧，不让它拖垮整批。
    const split = frame.lastIndexOf(" ");
    const location = frame.slice(split + 1);
    if (FIXED_FRAMES.has(location)) {
      kept.push(location);
      continue;
    }
    const match = /^(.+?)(?::(\d{1,8}))?(?::(\d{1,8}))?$/.exec(location);
    const file = match ? locations.resolve(match[1]!) : null;
    const line = match?.[2] ? Number(match[2]) : null;
    const column = match?.[3] ? Number(match[3]) : null;
    if (!file || [line, column].some((n) => n !== null && (n < 1 || n > MAX_LINE_OR_COLUMN))) {
      kept.push("<other>");
      continue;
    }
    const verified = `${file}${line !== null ? `:${line}${column !== null ? `:${column}` : ""}` : ""}`;
    const reported = split > 0 ? frame.slice(0, split).replace(/^(?:async|new) /, "").replace(/ \[as [^\]]*\]$/, "") : "";
    const name = locations.nameAt(file, line, reported);
    kept.push(name ? `${name} ${verified}` : verified);
  }
  return kept;
}

function scrubLocation(url: string | undefined, line: number | undefined, codeRoots: readonly string[], column?: number): string {
  if (!url) return "<native>";
  if (url.startsWith("node:")) return url.startsWith("node:internal/") ? "node:internal" : url.split(/[?#]/)[0]!.slice(0, 60);
  // 页面那一侧的代码根是 origin（`http://localhost:4317`），同源的脚本按 origin 之后那段算。
  for (const root of codeRoots) {
    if (/^https?:\/\//.test(root) && url.startsWith(`${root}/`)) {
      const rel = url.slice(root.length + 1).split(/[?#]/)[0]!;
      if (!/^[\w./@-]{1,160}$/.test(rel)) return "<other>";
      return `${rel}${typeof line === "number" ? `:${line}${typeof column === "number" ? `:${column}` : ""}` : ""}`;
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
    let match = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    // JavaScriptCore / Firefox：`fn@url:line:col`
    if (!match) {
      const jsc = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
      if (jsc) match = [jsc[0], jsc[1] || undefined, jsc[2], jsc[3], jsc[4]] as unknown as RegExpExecArray;
    }
    if (!match) continue;
    frames.push(scrubFrame(match[1], match[2], Number(match[3]), codeRoots, Number(match[4])));
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
 * 页面报上来的一条，按事件名只留白名单字段。认不出的事件返回 null。
 * 这是**服务端**的那道闸：页面那一侧也会先压一遍，但不能指望它。
 */
export function sanitizeWebEvent(
  input: unknown,
  { locations, digest }: {
    /** 页面代码的出处核对（只认 web 产物 / 源码里的文件）。 */
    locations: CodeLocations;
    /** 页面生成的标识换成摘要：页面塞什么都只剩散列，同一个标识换出来的还是同一串（拿来对身份）。 */
    digest: (id: string) => string;
  },
): Omit<RuntimeLogRecord, "at" | "src" | "pid"> | null {
  if (!input || typeof input !== "object") return null;
  const event = input as Record<string, unknown>;
  const ev = pick(event.ev, WEB_RUNTIME_EVENTS);
  if (!ev) return null;
  const out: Record<string, unknown> = { ev };
  const set = (key: string, value: unknown) => { if (value !== undefined) out[key] = value; };
  const id = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9]{4,16}$/.test(value) ? digest(value) : undefined);
  // tab：这个标签页；load：这一次载入（每次载入新起一个）。同一次载入的事件归同一次故障，不同载入不合并。
  set("tab", id(event.tab));
  set("load", id(event.load));
  set("shell", pick(event.shell, SHELLS));
  // 事件发生在发出之前多久（页面攒一批再发）：服务端拿它把时间拨回发生那一刻。
  set("ago", count(event.ago, 10 * 60_000));
  switch (ev) {
    case "page.boot":
      set("nav", pick(event.nav, NAV_TYPES));
      set("hidden", typeof event.hidden === "boolean" ? event.hidden : undefined);
      set("sincePrevMs", count(event.sincePrevMs));
      // 同一个标签页上一次载入的 load：把「那一次重载 / 崩溃」和「接着载进来的这一次」对成同一次。
      set("prev", id(event.prev));
      break;
    case "page.error":
    case "page.crash": {
      const name = scrubErrorName(event.name);
      set("kind", pick(event.kind, ERROR_KINDS));
      set("name", name);
      set("msg", isErrorTemplate(event.msg) ? event.msg : undefined);
      set("frames", verifyFrames(event.frames, locations));
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
    // 页面自己因为上限没报的详情（报错、断线）有几条：不报可以，不报了要说。
    case "page.skipped":
      set("count", count(event.count, 1_000_000));
      // 发出去没送到的条数：里面可能有载入 / 重载 / 崩溃。
      set("unsent", count(event.unsent, 1_000_000));
      break;
  }
  return out as Omit<RuntimeLogRecord, "at" | "src" | "pid">;
}

// ── 分析结果（server/src/runtime-log/analyze.ts 产出，设置页与 `npm run diagnose` 展示）──

export type CauseKind =
  | "sleep" | "restart" | "stall" | "webcontent" | "page_error" | "reload" | "load_failed" | "not_presented"
  | "not_ours" | "refused_connection" | "unknown";

/**
 * 这一次是谁看见的：桌面窗口（壳）还是页面自己。两边各数各的、不对成同一次（server/src/runtime-log/analyze-occurrences.ts），
 * 所以次数也分开报，不相加——同一次故障两边可能都记了。
 */
export type Observer = "window" | "page";

export const OBSERVER_LABELS: Record<Observer, string> = { window: "窗口", page: "页面" };

export type Incident = {
  at: string;
  seenBy: Observer;
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
  /** 按看见的那一方分开数的原因。 */
  causes: Record<Observer, Partial<Record<CauseKind, number>>>;
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
  load_failed: "页面没载出来",
  not_presented: "页面没显示出来",
  not_ours: "端口被占",
  refused_connection: "连接被拒",
  unknown: "原因不明",
};

/** 「窗口看到 3 次（…）；页面看到 1 次（…）」：两边各数各的，不相加。 */
export function observedCounts(report: RuntimeLogReport): string {
  return (Object.keys(OBSERVER_LABELS) as Observer[]).flatMap((observer) => {
    const causes = (Object.entries(report.causes[observer]) as Array<[CauseKind, number]>).sort((a, b) => b[1] - a[1]);
    const total = causes.reduce((sum, [, n]) => sum + n, 0);
    return total ? [`${OBSERVER_LABELS[observer]}看到 ${total} 次（${causes.map(([cause, n]) => `${CAUSE_LABELS[cause]} ${n}`).join("、")}）`] : [];
  }).join("；");
}
