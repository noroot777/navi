// 读运行日志：一个数据目录（库旁边的 logs/diagnostics/ + 退出账本），或者一份导出包。
// 服务端的报告、导出接口、`npm run diagnose` 都从这里拿数据，分析见 analyze.ts。
//
// 磁盘上读回来的每一条（日志和退出账本）都先过 project.ts 重新投影：写入端的白名单管不到更早版本写下的行。
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_LOG_BUNDLE_FORMAT, type RuntimeLogBundle, type RuntimeLogRecord,
} from "@navi/shared/runtime-log";
import { chooseDbFileIn, resolveNaviDbFile } from "../db/path.js";
import { publicExitSummary, readExitRecords, type ExitRecord } from "../exit-ledger.js";
import { runtimeLogDirForDb } from "./journal.js";
import { projectExit, projectRecord } from "./project.js";

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
      const record = projectRecord(JSON.parse(line));
      if (record) out.push(record);
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

/**
 * 退出账本往窗口前多读一天：窗口里第一条 `server.start` 的上一轮往往在窗口之外停的，读不到它就会
 * 把一次重启当成全新启动（第 1 轮审查）。
 */
const EXIT_MARGIN_MS = 86_400_000;
const exitsSince = (sinceMs: number | null) => (sinceMs === null ? null : sinceMs - EXIT_MARGIN_MS);

/**
 * 窗口里的记录，外加窗口之前**最后一次服务启动**当上下文：窗口里第一次重启要靠它认上一轮是谁（第 3 轮审查：
 * 上一轮起在七天之前时，先按日期裁掉它，这次重启就被当成认不出上一轮）。分析端只按窗口筛结果。
 */
function withContext(records: RuntimeLogRecord[], sinceMs: number | null): RuntimeLogRecord[] {
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sinceMs === null) return sorted;
  const before = sorted.filter((r) => Date.parse(r.at) < sinceMs && r.src === "server" && r.ev === "server.start").at(-1);
  return [...(before ? [before] : []), ...sorted.filter((r) => Date.parse(r.at) >= sinceMs)];
}

export function readRuntimeLogDir(dir: string, sinceMs: number | null = null): RuntimeLogRecord[] {
  const records: RuntimeLogRecord[] = [];
  for (const name of LOG_FILES) {
    records.push(...readFile(join(dir, `${name}.1`)), ...readFile(join(dir, name)));
  }
  return withContext(records, sinceMs);
}

function toSummary(record: ExitRecord): ExitSummary | null {
  return projectExit({ ...publicExitSummary(record)!, ...(record.runId ? { runId: record.runId } : {}) }) as ExitSummary | null;
}

function readExits(dbFile: string, sinceMs: number | null): ExitSummary[] {
  return since(readExitRecords(10_000, dbFile).map(toSummary).filter((exit): exit is ExitSummary => exit !== null), exitsSince(sinceMs));
}

/** 一个数据目录（mac app 的数据根、仓库里的 data/）。 */
export function loadDataDir(dataDir: string, sinceMs: number | null = null): LoadedRuntimeLog {
  let dbFile: string;
  try {
    dbFile = chooseDbFileIn(dataDir).file;
  } catch {
    dbFile = join(dataDir, "navi.db");
  }
  return { records: readRuntimeLogDir(runtimeLogDirForDb(dbFile), sinceMs), exits: readExits(dbFile, sinceMs) };
}

/** 本进程这份服务的。 */
export function loadOwnRuntimeLog(sinceMs: number | null = null): LoadedRuntimeLog {
  const dbFile = resolveNaviDbFile();
  return {
    records: readRuntimeLogDir(runtimeLogDirForDb(dbFile), sinceMs),
    exits: readExits(dbFile, sinceMs),
  };
}

export function buildRuntimeLogBundle(sinceMs: number | null): RuntimeLogBundle {
  const { records, exits } = loadOwnRuntimeLog(sinceMs);
  return {
    format: RUNTIME_LOG_BUNDLE_FORMAT,
    version: 2,
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
  // version 2 导出时已经投影过（栈帧按对方那份代码核对的，这边再核一遍会因为代码版本不同全变成 <other>）；
  // 更早的包是原样写盘的内容，照读目录那样投影一遍。
  const projected = bundle.version >= 2;
  const records = projected ? bundle.records : bundle.records.map(projectRecord).filter((r): r is RuntimeLogRecord => r !== null);
  const exits = projected ? bundle.exits : bundle.exits.map(projectExit).filter((e) => e !== null);
  return {
    records: withContext(records, sinceMs),
    exits: since(exits as ExitSummary[], exitsSince(sinceMs)),
    host: bundle.host,
  };
}
