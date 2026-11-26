// 换运行时之前给库留一份底（对应 mac 的 DatabaseBackup.beforeUpdate）：<数据根>\backups\<UTC 时间>-win-<旧运行时>.db。
// 新版服务起来时可能要迁移库结构，迁坏了靠这一份回到切换前。
//
// 用 SQLite 自己的在线备份（node:sqlite 的 backup），不拷文件：旧服务这时还开着库、WAL 里可能有没并进主文件的页，
// 直接拷 navi.db 得到的是半截。备份先写 .partial，写完再改名，半截的文件不会被当成能用的底。只留最近 5 份。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const KEEP = 5;

/** 数据根里那份库；还没有（没起过服务）是 null。 */
export function databaseFile(cfg) {
  return ["navi.db", "ash.db"].map((name) => join(cfg.dataDir, name)).find((file) => existsSync(file)) ?? null;
}

export async function backupDatabase(cfg, from, { now = new Date() } = {}) {
  const db = databaseFile(cfg);
  if (!db) return null;
  const dir = join(cfg.dataDir, "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d+Z$/, "");
  const base = `${stamp}-win-${String(from).replace(/[^\w.-]/g, "_").slice(0, 16)}`;
  let target = join(dir, `${base}.db`);
  for (let attempt = 2; existsSync(target); attempt += 1) target = join(dir, `${base}-${attempt}.db`);
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  const { DatabaseSync, backup } = await import("node:sqlite");
  const source = new DatabaseSync(db, { readOnly: true });
  try {
    await backup(source, partial);
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    source.close();
  }
  prune(dir);
  return target;
}

function prune(dir) {
  const ours = readdirSync(dir).filter((name) => /^\d{8}-\d{6}-win-.*\.db$/.test(name)).sort();
  for (const name of ours.slice(0, Math.max(0, ours.length - KEEP))) rmSync(join(dir, name), { force: true });
}
