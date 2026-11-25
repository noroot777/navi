// 用一份自带运行时起一个独立的 server 并等它报健康，mac（desktop/macos/scripts/smoke-distribution.mjs）与
// Windows（desktop/windows/scripts/smoke-runtime.mjs）的冒烟共用。只认自己起的那一个进程：health 报的 pid
// 必须是这个子进程，端口上碰巧有别的 Navi 也不会被当成成功。
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 外面这层进程（开发机的终端、Navi 的执行器）给开发实例设的环境不能漏进被测的服务：数据根、端口、
// 访问密钥都得是冒烟自己给的那一份。
const INHERITED_BLOCKLIST = /^(?:NAVI_|ASH_|PORT$|GH_TOKEN$|GITHUB_TOKEN$|MAC_RELEASE_TOKEN$|MAC_SPARKLE_PRIVATE_KEY$)/;

export async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

export function isolatedEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !INHERITED_BLOCKLIST.test(name)));
}

/** 起 `<runtime>/server/dist/index.js`，等 /api/health 报的是它自己；返回 { port, child, health, output, stop }。 */
export async function startServer({ node, runtime, dataDir, port, env = {}, timeoutMs = 60_000 }) {
  port ??= await freePort();
  let output = "";
  // POSIX 上让 server 自成一个进程组：停的时候按组停、按组确认，父进程先死了也找得到它的后代。
  const child = spawn(node, [join(runtime, "server/dist/index.js")], { cwd: runtime, env: {
    ...isolatedEnv(), NAVI_DATA_DIR: dataDir, PORT: String(port), NAVI_LOCAL_ONLY: "1", ...env,
  }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  let failure;
  child.on("error", (error) => { failure = error; });
  const server = { port, child, health: null, output: () => output, stop: () => stopServer(child) };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && !failure) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && body.pid === child.pid) { server.health = body; return server; }
    } catch {}
    await delay(200);
  }
  const notReady = new Error(`独立服务未就绪：${failure ?? ""}\n${output}`);
  try { await server.stop(); } catch (error) { notReady.message += `\n（停服务也失败了：${error.message}）`; }
  throw notReady;
}

/**
 * 停掉 server 和它起的进程，确认停干净了才返回，停不干净就抛。
 *
 * 判据不是「父进程退出了」：父进程先死了的时候它的后代可能还活着。POSIX 上按 startServer 建的进程组
 * 停、按组确认一个不剩。Windows 上没有能按「属于谁」认人的进程组，taskkill /T 只能沿还连着的父链走，
 * 父进程已经死了就无从追起 —— 那边的完整保证由调用方的 Job Object 给（desktop/windows/scripts/process-job.mjs），
 * 这里只负责把还活着的那棵树停掉。
 */
export async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const kill = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`taskkill 后 server 仍未退出：${kill.stdout}${kill.stderr}`)), 15_000);
    });
    try { await Promise.race([exited, late]); } finally { clearTimeout(timer); }
    return;
  }
  const group = -child.pid;
  const alive = () => {
    try { process.kill(group, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  const gone = async (ms) => {
    const deadline = Date.now() + ms;
    while (alive() && Date.now() < deadline) await delay(100);
    return !alive();
  };
  if (!alive()) return;
  try { process.kill(group, "SIGTERM"); } catch {}
  if (await gone(5000)) return;
  try { process.kill(group, "SIGKILL"); } catch {}
  if (!(await gone(5000))) throw new Error(`进程组 ${child.pid} 里仍有进程没退出`);
}
