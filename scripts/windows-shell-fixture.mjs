// test-windows-shell*.mjs 共用的假东西：一份能封成 format 2 的假运行时（里面的 server 是个只答 /api/health 的假服务），
// 空闲端口，和一个随手起的 HTTP 服务。
import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

// 假服务：按 app 交给它的环境在 PORT 和 NAVI_WINDOW_PORT 上答 /api/health，把看到的环境记进数据根，像真服务一样建库文件。
const FAKE_SERVER = `
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const env = process.env;
if (__CRASH__) { console.error("fake server crashed"); process.exit(1); }
const codeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = env.NAVI_DATA_DIR;
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "navi.db"), "");
const seen = Object.fromEntries(["NAVI_DATA_DIR", "NAVI_DESKTOP_APP", "NAVI_LOCAL_ONLY", "NAVI_WINDOW_PORT", "PORT"].map((key) => [key, env[key]]));
writeFileSync(join(dataDir, "fake-env.json"), JSON.stringify({ ...seen, codeDir }));
const id = "fake-" + process.pid + "-" + Date.now();
const body = JSON.stringify({ ok: true, pid: process.pid, instance: {
  id, dataDir, codeDir, desktop: env.NAVI_DESKTOP_APP === "1", localOnly: env.NAVI_LOCAL_ONLY === "1",
  windowPort: Number(env.NAVI_WINDOW_PORT), tag: "ABCD-1234" } });
const handler = (req, res) => { res.setHeader("content-type", "application/json"); res.end(body); };
for (const port of [Number(env.PORT || 4317), Number(env.NAVI_WINDOW_PORT)]) createServer(handler).listen(port, "127.0.0.1");
setTimeout(() => process.exit(0), 120_000);
process.on("SIGTERM", () => process.exit(0));
`;

export function fakeRuntime(directory, repo, { crash = false } = {}) {
  for (const folder of ["node", "server/dist", "scripts"]) mkdirSync(join(directory, folder), { recursive: true });
  // 运行时里的 node：转给跑测试的这个 node（Windows 包里不许有链接，所以是个脚本而不是软链）。
  const node = join(directory, "node", "node");
  writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(node, 0o755);
  writeFileSync(join(directory, "server/dist/index.js"), FAKE_SERVER.replace("__CRASH__", String(crash)));
  cpSync(join(repo, "scripts/start-detached.mjs"), join(directory, "scripts/start-detached.mjs"));
  cpSync(join(repo, "desktop/shared/runtime-store.mjs"), join(directory, "scripts/runtime-store.mjs"));
  writeFileSync(join(directory, ".in-use"), "");
  return directory;
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function listen(port, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}
