// 服务进程生命周期里的几件事：起来了、起不来、被单例锁挡回去、抛了没人接的异常。
// 退出那一侧不在这里记 —— exit-ledger.ts 已经有一份按 runId 对得上的账，分析时一起读。
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { totalmem, uptime as osUptime } from "node:os";
import { scrubErrorCode, scrubErrorMessage, scrubErrorName, scrubStack, scrubSyscall, verifyFrames } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";
import { serverCodeSymbols } from "./code-symbols.js";
import { runtimeLog } from "./journal.js";

/** 报错只留名单里的名字 / 错误码 / 系统调用、报错类别的固定说法和核对过出处的栈帧。 */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: typeof error };
  const name = scrubErrorName(error.name);
  const code = scrubErrorCode((error as NodeJS.ErrnoException).code);
  const syscall = scrubSyscall((error as NodeJS.ErrnoException).syscall);
  return {
    name,
    ...(code ? { code } : {}),
    ...(syscall ? { syscall } : {}),
    msg: scrubErrorMessage(name, error.message),
    frames: verifyFrames(scrubStack(error.stack, [CODE_DIR]), serverCodeSymbols),
  };
}

export function logProcessError(kind: "uncaught" | "rejection", error: unknown): void {
  runtimeLog("server.error", { kind, ...describeError(error) });
}

/** 起不来在哪一步：main.ts 里 exitAfterStartupFailure 的那几句。别的（端口冲突那句带端口号）记 `other`。 */
const STARTUP_STAGES = new Set([
  "unhandled rejection during startup", "uncaught exception during startup", "server initialization failed",
  "agent channel gateway failed", "scheduler failed to start", "server listen failed",
]);

export function logStartupFailure(stage: string, error: unknown): void {
  runtimeLog("server.startup_failed", { stage: STARTUP_STAGES.has(stage) ? stage : "other", ...(error ? describeError(error) : {}) });
}

/** 这份代码是哪一次构建的：入口文件的修改时间。分辨「重启前后是不是换了代码」用。 */
function buildStamp(): string | undefined {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

export function logServerStart(fields: {
  instance: string;
  runId: string | null;
  port: number;
  desktop: boolean;
  localOnly: boolean;
  preview: boolean;
  /** 启动时发现上一轮的锁还在（残留）：上一轮是谁、留下了什么证据。锁被正常删掉时是 null。 */
  previous: { run: string | null; evidence?: string; silentMs?: number | null; kind?: string; signal?: string } | null;
}): void {
  runtimeLog("server.start", {
    inst: fields.instance.slice(0, 8),
    run: fields.runId,
    port: fields.port,
    desktop: fields.desktop,
    localOnly: fields.localOnly,
    preview: fields.preview,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    build: buildStamp(),
    startupMs: Math.round(process.uptime() * 1000),
    osUptimeS: Math.round(osUptime()),
    memTotalMB: Math.round(totalmem() / 1024 / 1024),
    ...(fields.previous ? { previous: fields.previous } : {}),
  });
}
