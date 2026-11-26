// 读运行日志：一个数据目录（库旁边的 logs/diagnostics/ + 退出账本），或者一份导出包。
// 服务端的导出接口、`npm run diagnose` 都从这里拿数据，分析见 analyze.ts。
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_LOG_BUNDLE_FORMAT, type RuntimeLogBundle, type RuntimeLogRecord,
} from "@navi/shared/runtime-log";
import { chooseDbFileIn, resolveNaviDbFile } from "../db/path.js";
import { publicExitSummary, readExitRecords, type ExitRecord } from "../exit-ledger.js";
import { runtimeLogDirForDb } from "./journal.js";

/** 写这几份的进程各一份，加上各自轮转出来的上一代。 */
const LOG_FILES = ["server.jsonl", "mac.jsonl", "win.jsonl"];

export type LoadedRuntimeLog = { records: RuntimeLogRecord[]; exits: ExitSummary[] };

/** 退出账本里分析要用的那几项（公开投影 + runId，用来跟 server.start 对上）。 */
export type ExitSummary = ReturnType<typeof publicExitSummary> & { runId?: string };

function parseJsonl(text: string): RuntimeLogRecord[] {
  const out: RuntimeLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as RuntimeLogRecord;
      if (record && typeof record.at === "string" && typeof record.ev === "string") out.push(record);
    } catch {
      /* 半行、坏行跳过 */
    }
  }
  return out;
}

function readFile(file: string): RuntimeLogRecord[] {
  try {
    return parseJsonl(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function since<T extends { at: string }>(items: T[], sinceMs: number | null): T[] {
  if (sinceMs === null) return items;
  return items.filter((item) => Date.parse(item.at) >= sinceMs);
}

export function readRuntimeLogDir(dir: string, sinceMs: number | null = null): RuntimeLogRecord[] {
  const records: RuntimeLogRecord[] = [];
  for (const name of LOG_FILES) {
    records.push(...readFile(join(dir, `${name}.1`)), ...readFile(join(dir, name)));
  }
  return since(records, sinceMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function toSummary(record: ExitRecord): ExitSummary {
  return { ...publicExitSummary(record)!, ...(record.runId ? { runId: record.runId } : {}) };
}

/** 一个数据目录（mac app 的数据根、仓库里的 data/）。 */
export function loadDataDir(dataDir: string, sinceMs: number | null = null): LoadedRuntimeLog {
  let dbFile: string;
  try {
    dbFile = chooseDbFileIn(dataDir).file;
  } catch {
    dbFile = join(dataDir, "navi.db");
  }
  const exits = since(readExitRecords(10_000, dbFile).map(toSummary), sinceMs);
  return { records: readRuntimeLogDir(runtimeLogDirForDb(dbFile), sinceMs), exits };
}

/** 本进程这份服务的。 */
export function loadOwnRuntimeLog(sinceMs: number | null = null): LoadedRuntimeLog {
  const dbFile = resolveNaviDbFile();
  return {
    records: readRuntimeLogDir(runtimeLogDirForDb(dbFile), sinceMs),
    exits: since(readExitRecords(10_000, dbFile).map(toSummary), sinceMs),
  };
}

export function buildRuntimeLogBundle(sinceMs: number | null): RuntimeLogBundle {
  const { records, exits } = loadOwnRuntimeLog(sinceMs);
  return {
    format: RUNTIME_LOG_BUNDLE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    host: {
      platform: process.platform, arch: arch(), node: process.version, osRelease: release(),
      cpus: cpus().length, memoryMB: Math.round(totalmem() / 1024 / 1024),
    },
    records,
    exits: exits as Array<Record<string, unknown>>,
  };
}

/** 路径是导出包（.json 文件）还是数据目录，都认。 */
export function loadRuntimeLogPath(path: string, sinceMs: number | null = null): LoadedRuntimeLog & { host?: RuntimeLogBundle["host"] } {
  if (existsSync(join(path, ".")) && !path.endsWith(".json")) {
    // 给的是 logs/diagnostics 本身也认。
    if (LOG_FILES.some((name) => existsSync(join(path, name)))) return { records: readRuntimeLogDir(path, sinceMs), exits: [] };
    return loadDataDir(path, sinceMs);
  }
  const bundle = JSON.parse(readFileSync(path, "utf8")) as RuntimeLogBundle;
  if (bundle?.format !== RUNTIME_LOG_BUNDLE_FORMAT) throw new Error(`${path} 不是 Navi 运行日志导出包`);
  return {
    records: since(bundle.records, sinceMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    exits: since(bundle.exits as ExitSummary[], sinceMs),
    host: bundle.host,
  };
}
