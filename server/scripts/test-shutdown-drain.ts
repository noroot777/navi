// 关服排空（server/src/shutdown-resources.ts + singleton.ts 的信号处理器）：
//   ① 服务收到 SIGTERM：正在跑的「AI 协助」智能体就算不理 TERM，也在服务退出前被收掉，不留在后台继续跑
//   ② 配合 TERM 的照样收掉；收完才放锁、按信号的退出码退
//   ③ 没有要排空的东西：和原来一样立刻退
//
// 「服务」是这个脚本自己再起的一个子进程（argv[2] === "child"）：拿单例锁、起一份 AI 协助，执行器是真的
// CodexExecutor / spawn / 进程归属，只把 CLI 换成本地心跳程序（不接模型、不烧额度），然后等父进程发 SIGTERM。
// 只在 POSIX 上跑：Windows 停服务不发信号，是整树结束（scripts/platform.mjs killServerProcess）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (process.argv[2] === "child") {
  const [, , , root, mode] = process.argv;
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  assert.ok(acquireDbSingletonLock({ port: null }));
  if (mode === "idle") {
    console.log("READY");
  } else {
    const { ensureSchema, db } = await import("../src/db/index.js");
    await ensureSchema();
    const { projects } = await import("../src/db/schema.js");
    await db.insert(projects).values({ id: "p", name: "p", repoPath: root, createdAt: new Date().toISOString() });
    const { CodexExecutor } = await import("../src/executors/codex.js");
    const run = CodexExecutor.prototype.run;
    CodexExecutor.prototype.run = function (this: { bin: string }, opts) { this.bin = join(root, "bin", "fake-codex"); return run.call(this, opts); };
    const { startPreviewAssist } = await import("../src/preview-assist.js");
    await startPreviewAssist({ projectId: "p", claim: "t", cwd: root, mode: "frontend", currentScript: "", agentType: "codex" });
    for (let i = 0; i < 100 && !existsSync(join(root, "pid")); i++) await sleep(50);
    const { shutdownResources } = await import("../src/shutdown-resources.js");
    console.log(`READY ${JSON.stringify((await shutdownResources()).resources.map((r) => r.kind))}`);
  }
  setInterval(() => {}, 1000); // 等父进程发信号
} else if (process.platform === "win32") {
  console.log("- 跳过：Windows 停服务不发信号（整树结束）");
} else {
  async function scenario(mode: "ignores-term" | "cooperative" | "idle") {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "navi-shutdown-drain-")));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "home"));
    const fake = join(root, "bin", "fake-codex");
    const onTerm = mode === "ignores-term" ? "process.on('SIGTERM',()=>{});" : "";
    writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');${onTerm}fs.writeFileSync(${JSON.stringify(join(root, "pid"))},String(process.pid));`
      + `process.stdin.resume();let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(join(root, "beat"))},String(++n)),100);setTimeout(()=>process.exit(0),30000);`);
    chmodSync(fake, 0o755);
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "child", root, mode], {
      cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, HOME: join(root, "home"), NAVI_DATA_DIR: root, NAVI_DB: join(root, "t.db"), NAVI_RUNS_DIR: join(root, "runs"),
        NAVI_TEST_AGENT_BIN: join(root, "bin") },
    });
    let out = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 300 && !out.includes("READY"); i++) await sleep(100);
    assert.ok(out.includes("READY"), `「服务」没起来：${out}`);
    const agent = mode === "idle" ? 0 : Number(readFileSync(join(root, "pid"), "utf8"));
    if (agent) assert.match(out, /preview-assist/, "起着的 AI 协助在随服务关掉的名单里");
    const began = Date.now();
    child.kill("SIGTERM");
    const code = await exited;
    const took = Date.now() - began;
    assert.equal(code, 143, "按 SIGTERM 的退出码退");
    assert.equal(existsSync(join(root, "t.db.navi.lock")), false, "收完才放锁，放了");
    if (mode === "idle") {
      assert.ok(took < 1_500, `没有要排空的就立刻退（用了 ${took}ms）`);
    } else {
      await sleep(1_000);
      const before = existsSync(join(root, "beat")) ? readFileSync(join(root, "beat"), "utf8") : "";
      await sleep(1_000);
      const after = existsSync(join(root, "beat")) ? readFileSync(join(root, "beat"), "utf8") : "";
      const still = alive(agent);
      if (still) { try { process.kill(-agent, "SIGKILL"); } catch { /* */ } try { process.kill(agent, "SIGKILL"); } catch { /* */ } }
      assert.equal(still, false, `服务退了，AI 协助的智能体（${mode}）也得没了`);
      assert.equal(before, after, "也不再干活");
    }
    return took;
  }
  const slow = await scenario("ignores-term");
  console.log(`✓ 服务收到 SIGTERM：不理 TERM 的 AI 协助智能体也在退出前收掉（用了 ${slow}ms），收完才放锁`);
  await scenario("cooperative");
  console.log("✓ 配合 TERM 的照样收掉");
  await scenario("idle");
  console.log("✓ 没有要排空的东西：和原来一样立刻退");
}
