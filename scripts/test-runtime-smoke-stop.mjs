// 冒烟起的 server「停干净」的判据：父进程退出了不算，它起的进程一个都不剩才算。
// 用一个假运行时（server 起来后再起一个常驻的孙进程），两种停法都要把孙进程带走：
//   · 正常停：stopServer；
//   · 父进程先死了（被单独杀掉），孙进程成了孤儿，再 stopServer —— POSIX 上靠进程组，Windows 上 stopServer
//     追不到死父进程的后代，由冒烟的 Job Object 回收（desktop/windows/scripts/process-job.mjs）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../desktop/shared/runtime-smoke.mjs";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";

const WINDOWS = process.platform === "win32";
const job = WINDOWS ? await (await import("../desktop/windows/scripts/process-job.mjs")).claimProcessJob() : null;
// Job 一拿到，后面的每一步（连建临时目录、写假运行时在内）都在 try 里：哪一步失败，finally 都放开 Job、删目录。
let temporary;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
async function gone(pid) {
  const deadline = Date.now() + 10_000;
  while (alive(pid) && Date.now() < deadline) await delay(100);
  return !alive(pid);
}
const grandchildren = [];

try {
  reclaimScratch(tmpdir(), "navi-runtime-smoke-stop-");
  temporary = realpathSync(claimScratch(tmpdir(), "navi-runtime-smoke-stop-"));
  const runtime = join(temporary, "runtime");
  mkdirSync(join(runtime, "server/dist"), { recursive: true });
  writeFileSync(join(runtime, "server/dist/index.js"), `
  const http = require("node:http");
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  // Windows 上 libuv 会把非 detached 的子进程收进自己的容器、随 server 一起结束，所以那边用 detached 造出
  // 「server 死了它还活着」的孤儿；POSIX 上不 detached 它就留在 server 的进程组里，正是审查复现的那种。
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: process.platform === "win32" });
  fs.writeFileSync(process.env.NAVI_DATA_DIR + "/grandchild.pid", String(grandchild.pid));
  http.createServer((req, res) => res.end(JSON.stringify({ ok: true, pid: process.pid }))).listen(Number(process.env.PORT), "127.0.0.1");
  `);

  for (const parentDiesFirst of [false, true]) {
    const data = join(temporary, parentDiesFirst ? "orphan" : "normal");
    mkdirSync(data);
    const server = await startServer({ node: process.execPath, runtime, dataDir: data });
    let pid;
    for (let i = 0; i < 50 && !pid; i++) {
      try { pid = Number(readFileSync(join(data, "grandchild.pid"), "utf8")); } catch { await delay(100); }
    }
    assert.ok(pid && alive(pid), "孙进程没起来");
    grandchildren.push(pid);
    if (parentDiesFirst) {
      if (WINDOWS) spawnSync("taskkill", ["/PID", String(server.child.pid), "/F"], { stdio: "ignore" });
      else process.kill(server.child.pid, "SIGKILL");
      assert.ok(await gone(server.child.pid), "server 没被单独杀掉");
      assert.ok(alive(pid), "孙进程应当还活着（这才是要验的孤儿）");
    }
    await server.stop();
    if (WINDOWS) await job.reap();
    assert.ok(await gone(pid), `${parentDiesFirst ? "父进程先死时" : "正常停时"}孙进程 ${pid} 还活着`);
    console.log(`✓ ${parentDiesFirst ? "父进程先死了" : "正常停"}：server 起的孙进程也一起结束${WINDOWS ? "（Job 回收后只剩冒烟自己）" : "（按进程组）"}`);
  }

  if (WINDOWS) {
    // 冒烟一开头就拿 Job，后面哪一步先失败都得把 Job 放开：Job 的帮手进程连着 stdin 管道，没放开 node 就永远退不了。
    // 这里给一个不存在的工作目录，让它在建临时目录那一步就失败；要的是「很快、带着原因退出」，不是挂到外层期限。
    const early = spawnSync(process.execPath, [fileURLToPath(new URL("../desktop/windows/scripts/smoke-runtime.mjs", import.meta.url)), runtime, join(temporary, "no-such-work")], { encoding: "utf8", timeout: 90_000 });
    assert.equal(early.signal, null, "冒烟在拿到 Job 之后早早失败，90 秒内没退出");
    assert.equal(early.status, 1, early.stdout + early.stderr);
    assert.match(early.stderr, /ENOENT/);
    await job.reap();
    console.log("✓ 冒烟拿到 Job 之后早早失败：放开 Job、带着原因退出，不挂住");
  }
} finally {
  for (const pid of grandchildren) if (alive(pid)) process.kill(pid, "SIGKILL");
  job?.release();
  if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
