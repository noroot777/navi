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
  const child = spawn(node, [join(runtime, "server/dist/index.js")], { cwd: runtime, env: {
    ...isolatedEnv(), NAVI_DATA_DIR: dataDir, PORT: String(port), NAVI_LOCAL_ONLY: "1", ...env,
  }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  await server.stop();
  throw new Error(`独立服务未就绪：${failure ?? ""}\n${output}`);
}

/** 停掉 server 和它的整棵进程树。Windows 上没有 SIGTERM，跟 scripts/stop.mjs 一样走 taskkill /T。 */
export async function stopServer(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") {
    const kill = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true });
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`taskkill 后 server 仍未退出：${kill.stdout}${kill.stderr}`)), 15_000);
    });
    try { await Promise.race([exited, late]); } finally { clearTimeout(timer); }
    return;
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
