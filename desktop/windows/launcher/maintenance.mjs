// 维护期：正在按新设置重启服务（RemoteAccessSwitch）、以后还有换运行时这段时间，任何入口都不许起服务 ——
// 窗口的探活、登录时的 `--start-server`、另开的一份壳都一样（对应 mac 的 Maintenance）。所以它记在数据根里，
// 不只在本进程内存里。两样一起用：
//   · 启动锁由维护方一直攥着：正在起服务的那一处做完之前维护方拿不到它、也就不会去停服务；
//   · 标记文件说明「为什么不起」。持有它的进程活着才算数，进程没了标记就作废；别的进程的超过一刻钟也作废（防进程号复用）。
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireStartLock } from "./start-lock.mjs";

const STALE_AFTER_MS = 15 * 60_000;
const markerFile = (cfg) => join(cfg.dataDir, ".win-maintenance.json");

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function readMarker(cfg) {
  try {
    const marker = JSON.parse(readFileSync(markerFile(cfg), "utf8"));
    return Number.isInteger(marker?.pid) && typeof marker.note === "string" && Number.isFinite(marker.since) ? marker : null;
  } catch { return null; }
}

/** 有维护在进行就返回那句说给用户听的话。作废的标记顺手删掉。 */
export function activeHold(cfg) {
  const marker = readMarker(cfg);
  if (!marker) return null;
  if (marker.pid === process.pid) return marker.note;
  if (isPidAlive(marker.pid) && Date.now() - marker.since < STALE_AFTER_MS) return marker.note;
  rmSync(markerFile(cfg), { force: true });
  return null;
}

/** 攥住启动锁、写标记。另一处正在起服务时等它做完，等满 timeoutMs 还拿不到就报错。 */
export async function beginMaintenance(cfg, note, timeoutMs) {
  const lock = await acquireStartLock(cfg.dataDir, { timeoutMs });
  if (!lock.release) throw new Error(`另一处正在起 Navi 服务，${Math.round(timeoutMs / 1000)} 秒还没完`);
  try {
    const stage = `${markerFile(cfg)}.${process.pid}.partial`;
    writeFileSync(stage, JSON.stringify({ pid: process.pid, note, since: Date.now() }));
    renameSync(stage, markerFile(cfg));
  } catch (error) { lock.release(); throw error; }
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    if (readMarker(cfg)?.pid === process.pid) rmSync(markerFile(cfg), { force: true });
    lock.release();
  };
}
