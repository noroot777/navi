// 读出来的运行日志一律在这里重新投影一遍，报告、时间线、导出包、`npm run diagnose` 只用投影之后的。
//
// 写入端的白名单只能管住**它自己**写的：磁盘上的 JSONL 还可能是更早的版本写的（本任务初版就把报错原文
// 写进过 `msg`，第 4 轮复审实测导出照样带了出去）、被别的进程追加的、被手改过的。所以读的这一侧不信写的
// 那一侧，按同一套规则再认一遍：每个事件只留下面表里列出的字段，每个字段的取值要么来自固定集合（名单、
// 枚举、固定说法），要么能核对出处（栈帧位置），要么只是数字和时间；认不出的事件整条不要，认不出的字段、
// 取值不在名单里的直接删掉（不是替换成「长得安全」的样子）。
//
// 路由模板读回来时没法核对（读的时候手上没有服务端的路由注册表，CLI 更没有）：只有带着当前格式号（`v`）的
// 记录才留——带这个号的写入端只写 Hono 注册的模板（http.ts）；更早的写入端写过真实请求路径。
import {
  ERROR_KINDS, NAV_TYPES, RUNTIME_LOG_SCHEMA, SHELLS, WEB_RELOAD_REASONS, isErrorTemplate, routePattern,
  scrubErrorCode, scrubErrorName, scrubMethod, scrubSyscall, verifyFrames, type CodeLocations, type RuntimeLogRecord,
} from "@navi/shared/runtime-log";
import { serverCodeLocations, webCodeLocations } from "./code-symbols.js";
import { STARTUP_STAGES } from "./process-events.js";

type Ctx = { record: Record<string, unknown>; locations: CodeLocations };
type Check = (value: unknown, ctx: Ctx) => unknown;

const num: Check = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e13 ? v : undefined);
const bool: Check = (v) => (typeof v === "boolean" ? v : undefined);
const iso: Check = (v) => {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
const oneOf = (allowed: readonly string[]): Check => (v) => (typeof v === "string" && allowed.includes(v) ? v : undefined);
const shape = (pattern: RegExp): Check => (v) => (typeof v === "string" && pattern.test(v) ? v : undefined);
/** 服务端生成的随机标识 / 摘要：只有十六进制。 */
const hex = (min: number, max: number) => shape(new RegExp(`^[0-9a-f-]{${min},${max}}$`));

const errorName: Check = (v) => scrubErrorName(v);
const errorCode: Check = (v) => scrubErrorCode(v);
const syscall: Check = (v) => scrubSyscall(v);
const msg: Check = (v) => (isErrorTemplate(v) ? v : undefined);
const frames: Check = (v, { locations }) => (Array.isArray(v) ? verifyFrames(v, locations) : undefined);
const method: Check = (v) => (v === undefined ? undefined : scrubMethod(v));
const route: Check = (v, { record }) => {
  if (record.v !== RUNTIME_LOG_SCHEMA) return undefined;
  const pattern = routePattern(v);
  return pattern === "?" ? undefined : pattern;
};
const signal = shape(/^SIG[A-Z0-9]{2,10}$/);
const version = shape(/^\d{1,4}(?:\.\d{1,6}){0,3}(?:[-+][0-9A-Za-z.]{1,24})?$/);

const object = (fields: Record<string, Check>): Check => (v, ctx) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(fields)) {
    const value = check((v as Record<string, unknown>)[key], ctx);
    if (value !== undefined) out[key] = value;
  }
  return out;
};
const list = (item: Check, max: number): Check => (v, ctx) => (Array.isArray(v)
  ? v.slice(0, max).map((entry) => item(entry, ctx)).filter((entry) => entry !== undefined)
  : undefined);

const ERROR_FIELDS = { name: errorName, code: errorCode, syscall, msg, frames };
const PROBE_FIELDS = {
  probe: oneOf(["down", "unreachable", "not_navi", "ours", "not_ours"]), code: errorCode, status: shape(/^(?:\d{3}|\?)$/),
  serverPid: num, streak: num, via: oneOf(["guard", "navigation"]),
};
const EVENT_NAME = /^[a-z_]{2,24}(?:\.[a-z_]{2,24}){1,3}$/;

/** 每个事件能带哪些字段。`at` `src` `pid` `ev` `v` 是公共的，另外处理。 */
const SCHEMA: Record<string, Record<string, Check>> = {
  // 服务端
  "server.start": {
    inst: hex(8, 8), run: hex(8, 16), port: num, desktop: bool, localOnly: bool, preview: bool,
    node: shape(/^v\d{1,3}\.\d{1,4}\.\d{1,4}$/), platform: oneOf(["darwin", "win32", "linux", "freebsd", "openbsd", "sunos", "aix"]),
    arch: oneOf(["arm64", "x64", "ia32", "arm", "ppc64", "s390x", "riscv64", "loong64"]), build: iso,
    startupMs: num, osUptimeS: num, memTotalMB: num,
    previous: object({
      run: hex(8, 16), evidence: oneOf(["exit_intent", "none"]), silentMs: num, kind: oneOf(["signal", "exit"]), signal,
    }),
  },
  "server.refused": { holderPid: num, reason: oneOf(["lock_error"]) },
  "server.error": { kind: oneOf(["uncaught", "rejection"]), ...ERROR_FIELDS },
  "server.startup_failed": { stage: (v) => (typeof v === "string" && (STARTUP_STAGES.has(v) || v === "other") ? v : undefined), ...ERROR_FIELDS },
  "http.slow": { route, method, ms: num, status: num },
  "gc.long": { ms: num, kind: num, heapMB: num },
  "system.sleep": { ms: num, from: iso },
  "loop.stall": {
    n: num, ms: num, from: iso, cpuMs: num, gcMs: num, rssMB: num, heapMB: num,
    inflight: list(object({ method, route: (v, ctx) => route(v, ctx), ageMs: num, done: bool }), 10),
  },
  "loop.stall.stack": { n: num, ms: num, samples: num, stacks: list(object({ pct: num, frames }), 3) },
  "server.vitals": {
    rssMB: num, heapMB: num, heapLimitMB: num, externalMB: num, cpuPct: num, loopP99Ms: num, loopMaxMs: num,
    handles: num, served: num, inflight: num,
  },
  "memory.high": { heapMB: num, heapLimitMB: num },
  "log.dropped": { of: shape(EVENT_NAME), count: num },
  "log.dropping": { of: shape(EVENT_NAME) },
  // 页面（见 sanitizeWebEvent；标识收下时已换成摘要）
  "page.boot": { tab: hex(12, 12), load: hex(12, 12), prev: hex(12, 12), shell: oneOf(SHELLS), nav: oneOf(NAV_TYPES), hidden: bool, sincePrevMs: num },
  "page.error": { tab: hex(12, 12), load: hex(12, 12), shell: oneOf(SHELLS), kind: oneOf(ERROR_KINDS), ...ERROR_FIELDS },
  "page.crash": { tab: hex(12, 12), load: hex(12, 12), shell: oneOf(SHELLS), kind: oneOf(ERROR_KINDS), ...ERROR_FIELDS },
  // 页面重载两边都记：页面报的带 tab/load 和发起原因，壳记的带服务的进程号 / 实例号。
  "page.reload": {
    tab: hex(12, 12), load: hex(12, 12), shell: oneOf(SHELLS),
    reason: oneOf([...WEB_RELOAD_REASONS, "instance_changed", "user"]), serverPid: num, inst: hex(8, 8),
  },
  "events.down": { tab: hex(12, 12), load: hex(12, 12), shell: oneOf(SHELLS) },
  "events.up": { tab: hex(12, 12), load: hex(12, 12), shell: oneOf(SHELLS), downMs: num },
  // 桌面壳（desktop/macos/Sources/RuntimeLog.swift）
  "app.launch": { version, os: shape(/^Version [\d.]{1,16} \(Build [0-9A-Za-z]{1,16}\)$/) },
  "app.quit": {},
  "server.spawn": { serverPid: num, version },
  "server.ensure": { outcome: oneOf(["ready", "needs_setup", "occupied", "failed"]), ms: num },
  "cover.show": { kind: oneOf(["starting", "maintenance"]) },
  "cover.hide": {},
  "page.presented": {},
  "page.not_presented": { why: oneOf(["script", "timeout"]) },
  "page.load_failed": { domain: oneOf(["NSURLErrorDomain", "WebKitErrorDomain", "NSPOSIXErrorDomain", "WKErrorDomain"]), code: errorCode },
  "page.takedown": PROBE_FIELDS,
  "probe.miss": PROBE_FIELDS,
  "webcontent.terminated": {},
};

const SOURCES = ["server", "web", "mac", "win"] as const;

/** 一条读回来的记录 → 能对外的样子；认不出的事件返回 null。 */
export function projectRecord(raw: unknown): RuntimeLogRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const at = iso(record.at, { record, locations: serverCodeLocations }) as string | undefined;
  const src = oneOf(SOURCES)(record.src, { record, locations: serverCodeLocations }) as RuntimeLogRecord["src"] | undefined;
  const ev = typeof record.ev === "string" ? record.ev : "";
  const fields = SCHEMA[ev];
  if (!at || !src || !fields) return null;
  const ctx: Ctx = { record, locations: src === "web" ? webCodeLocations : serverCodeLocations };
  const out: RuntimeLogRecord = { at, src, ev };
  const pid = num(record.pid, ctx);
  if (pid !== undefined) out.pid = pid as number;
  for (const [key, check] of Object.entries(fields)) {
    const value = check(record[key], ctx);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 退出账本的公开投影（publicExitSummary）读回来也再认一遍：它同样进导出包。 */
export function projectExit(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const ctx: Ctx = { record, locations: serverCodeLocations };
  const at = iso(record.at, ctx);
  const kind = oneOf(["signal", "exit", "residual"])(record.kind, ctx);
  if (!at || !kind) return null;
  const intent = object({ kind: oneOf(["signal", "exit"]), signal, code: num, at: iso });
  const fields: Record<string, Check> = {
    pid: num, signal, code: num, uptimeMs: num, lastHeartbeatAt: iso, silentMs: num,
    evidence: oneOf(["exit_intent", "none"]), observedIntent: intent, runId: hex(8, 16),
  };
  const out: Record<string, unknown> = { at, kind };
  for (const [key, check] of Object.entries(fields)) {
    const value = check(record[key], ctx);
    if (value !== undefined) out[key] = value;
  }
  return out;
}
