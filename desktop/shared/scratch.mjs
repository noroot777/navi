// 冒烟和测试用的临时目录：建的时候记下属主进程，下一次同类运行开头把属主已经不在了的那些收掉。
//
// 只在自己的 finally 里删目录，管不住「进程本身被强杀」：外层期限到了、开发机按了 Ctrl-C、会话被掐，
// finally 一行都执行不到。所以删除不能只挂在可能被杀的那个进程上 —— 目录里放一份属主记录，谁再起一次
// 同前缀的运行，谁就替死掉的属主收尸。判据保守：属主还活着（或 pid 被别的进程复用了）就不动，
// 宁可多留一会儿，也不删别人正在用的目录。
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = ".navi-owner.json";
// 没有属主记录的目录：要么刚 mkdtemp、记录还没写（微秒级），要么是加这套之前留下的。一小时足够分开两者。
const ORPHAN_AGE_MS = 60 * 60_000;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** 在 `parent` 下建 `<prefix>XXXXXX`，写上属主（当前进程）。 */
export function claimScratch(parent, prefix) {
  const directory = mkdtempSync(join(parent, prefix));
  writeFileSync(join(directory, OWNER), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return directory;
}

/** 收掉 `parent` 下同前缀、属主已经不在的目录；返回 { removed, failed }（failed 是删不掉的，留给下一次）。 */
export function reclaimScratch(parent, prefix, { now = Date.now() } = {}) {
  const removed = [];
  const failed = [];
  let names = [];
  try { names = readdirSync(parent).filter((name) => name.startsWith(prefix)); } catch { return { removed, failed }; }
  for (const name of names) {
    const directory = join(parent, name);
    try {
      if (!statSync(directory).isDirectory()) continue;
      let owner = null;
      try { owner = JSON.parse(readFileSync(join(directory, OWNER), "utf8")); } catch {}
      if (owner ? processAlive(owner.pid) : now - statSync(directory).mtimeMs < ORPHAN_AGE_MS) continue;
      rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
      removed.push(directory);
    } catch (error) {
      failed.push(`${directory}：${error.message}`);
    }
  }
  return { removed, failed };
}
