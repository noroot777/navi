// 同一个数据根同一时刻只许一处在「起服务」：打开的窗口、登录时的 `--start-server`、另一个窗口的重试可能同时
// 发现服务不在（对应 mac 的 ServerStartLock.swift）。锁文件放在数据根里，跟着数据走。
//
// Windows 上 node 没有 flock，但 libuv 的 UV_FS_O_EXLOCK 会以共享模式 0 打开文件：别的进程再打开就是
// EBUSY（共享冲突），持有者进程一退出内核就关掉句柄、锁随之放开，不会留下死锁。mac 上（回归测试）用 O_EXLOCK。
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const UV_FS_O_EXLOCK = constants.UV_FS_O_EXLOCK ?? 0x1000_0000;
const DARWIN_EXLOCK = 0x20;

export const startLockFile = (dataDir) => join(dataDir, ".win-launch.lock");

/** 拿到就返回一个 release()，被别人拿着返回 null。 */
export function tryStartLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const flags = constants.O_CREAT | constants.O_RDWR
    | (process.platform === "win32" ? UV_FS_O_EXLOCK : DARWIN_EXLOCK | constants.O_NONBLOCK);
  let descriptor;
  try { descriptor = openSync(startLockFile(dataDir), flags, 0o600); }
  catch (error) {
    if (["EBUSY", "EAGAIN", "EWOULDBLOCK"].includes(error.code)) return null;
    throw error;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    closeSync(descriptor);
  };
}

/** 等到拿上（或 `until()` 先给出结论、或超时），返回 { release } / { settled } / { timeout: true }。 */
export async function acquireStartLock(dataDir, { timeoutMs, until = async () => null, pause = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryStartLock(dataDir);
    if (release) return { release };
    const settled = await until();
    if (settled) return { settled };
    if (Date.now() >= deadline) return { timeout: true };
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
