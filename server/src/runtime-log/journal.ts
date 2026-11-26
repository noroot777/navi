// 运行日志的落盘端（格式与脱敏规则见 @navi/shared/runtime-log）。
//
// 放在库旁边的 `logs/diagnostics/` 底下：mac app 的数据根就是库所在的目录，壳自己的那份
// （mac.jsonl）写在同一处，导出、分析都只认这一个目录。预览实例的库在别处，各自一份，不会混进来。
//
// 三条约束：
//   · **写入一律 best-effort**：这份日志跑在卡顿检测、退出路径上，磁盘满、权限不对都只能丢这一条，
//     不能让它反过来把服务搞崩或搞慢 —— 所以同步追加、吞掉异常，单条有长度上限。
//   · **按事件限流**：一条坏路径每秒抛几百次异常时，日志不能跟着涨成几个 G。超出的只数个数，
//     下一次放行时补一条 `log.dropped`。
//   · **轮转只改名**（同 exit-ledger.ts 的理由）：同一个目录可能有别的进程在追加（被单例锁挡回去
//     的那一份也会记一条 `server.refused`），读-改-写会吞掉别人刚写的记录。
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeLogRecord, RuntimeLogSource } from "@navi/shared/runtime-log";
import { resolveNaviDbFile } from "../db/path.js";

/** 单个文件超过这么大就轮转成 `.1`。两代合起来够看两三周的卡顿和重启。 */
const ROTATE_BYTES = 4 * 1024 * 1024;
/** 一条记录的上限：超出说明有字段没压住，宁可丢掉也不写半截。 */
const MAX_LINE = 8 * 1024;
/** 每个事件名每分钟最多写几条。 */
const PER_MINUTE = 30;

export function runtimeLogDirForDb(dbFile = resolveNaviDbFile()): string {
  return join(dirname(dbFile), "logs", "diagnostics");
}

export const SERVER_LOG_NAME = "server.jsonl";

let dir: string | null = null;
let ensured = false;
let writesSinceCheck = 0;
const buckets = new Map<string, { windowStart: number; used: number; dropped: number }>();

function logFile(): string {
  dir ??= runtimeLogDirForDb();
  return join(dir, SERVER_LOG_NAME);
}

function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size > ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // 不存在 / 改不了名：文件偏大而已。
  }
}

function admit(ev: string, now: number): number | null {
  const bucket = buckets.get(ev) ?? { windowStart: now, used: 0, dropped: 0 };
  if (now - bucket.windowStart >= 60_000) {
    const dropped = bucket.dropped;
    bucket.windowStart = now;
    bucket.used = 0;
    bucket.dropped = 0;
    buckets.set(ev, bucket);
    bucket.used += 1;
    return dropped;
  }
  buckets.set(ev, bucket);
  if (bucket.used >= PER_MINUTE) {
    bucket.dropped += 1;
    return null;
  }
  bucket.used += 1;
  return 0;
}

function append(record: RuntimeLogRecord): void {
  const line = JSON.stringify(record);
  if (line.length > MAX_LINE) return;
  const file = logFile();
  try {
    if (!ensured) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      ensured = true;
      rotateIfLarge(file);
    }
    if (++writesSinceCheck >= 200) {
      writesSinceCheck = 0;
      rotateIfLarge(file);
    }
    // 前后各带换行：上一个进程写到半行就没了时，这一条照样自成一行（解析端跳空行和坏行）。
    appendFileSync(file, `\n${line}\n`, { mode: 0o600 });
  } catch {
    /* 日志写不进去不影响服务本身 */
  }
}

/**
 * 记一条。`fields` 只放数字、枚举、已经脱敏的短串 —— 调用点负责，这里不再猜。
 * `src` 缺省是服务端自己；页面报上来的由路由传 `web`。
 */
export function runtimeLog(ev: string, fields: Record<string, unknown> = {}, src: RuntimeLogSource = "server", agoMs = 0): void {
  const now = Date.now();
  const dropped = admit(`${src}:${ev}`, now);
  if (dropped === null) return;
  if (dropped > 0) append({ at: new Date(now).toISOString(), src, pid: process.pid, ev: "log.dropped", of: ev, count: dropped });
  // 页面攒一批再发，`agoMs` 是事件发生在收到之前多久：记发生的时刻，跨来源对时间线才对得上。
  append({ at: new Date(now - agoMs).toISOString(), src, pid: process.pid, ev, ...fields });
}

/** 测试与导出用：换一个目录（同一进程里只该在写第一条之前调）。 */
export function setRuntimeLogDir(next: string): void {
  dir = next;
  ensured = false;
}

export function runtimeLogDir(): string {
  return dirname(logFile());
}
