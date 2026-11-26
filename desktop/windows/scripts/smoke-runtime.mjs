#!/usr/bin/env node
// 在 Windows 上用一份 bundle-runtime.mjs 做出来的运行时走一遍真实路径：发布 → 自带 node 的 sqlite / ConPTY →
// 用临时数据目录、非 4317 端口起 server → health、经 API 读写库、经终端 API 用 ConPTY 跑一条命令读到输出、
// 取 web 页面 → 停干净（进程、文件都不留）。
//
//   node desktop/windows/scripts/smoke-runtime.mjs <运行时目录> [工作目录]
//
// 跑这个脚本的 node 随意（系统里装的就行），被测的一律是运行时自带的 node.exe。一切都落在工作目录（缺省 %TEMP%）
// 下新建的一个临时目录里：它充当 LOCALAPPDATA（发布到 <临时>\Navi\runtimes\<sha256>、数据根 <临时>\Navi\data），
// server 的 USERPROFILE/APPDATA 也指过去，不碰这台机器上已有的 Navi、它的端口和数据。
//
// 停干净靠 Job Object（process-job.mjs）：起任何进程之前先把自己收进容器，收尾时容器里除自己外一个不剩才算数，
// 不靠父进程号追树。冒烟成功、失败都走同一段收尾，每一步各自兜底，前一步失败不跳过后一步。冒烟自己被强杀、
// 收尾没走到时，容器随它一起关掉（里面的进程由内核结束），临时目录由下一次冒烟认出属主已经不在、收掉（scratch.mjs）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installRuntime } from "../../shared/runtime-store.mjs";
import { startServer } from "../../shared/runtime-smoke.mjs";
import { claimScratch, reclaimScratch } from "../../shared/scratch.mjs";
import { scanWindowsBinaries } from "./binary-check.mjs";
import { dataRoot, runtimeStore } from "./layout.mjs";
import { claimProcessJob } from "./process-job.mjs";

const step = (line) => console.log(`✓ ${line}`);
// %TEMP% 常是 8.3 短名（C:\Users\ADMINI~1\...），server 报的、进程表里记的是长名：比较前都换成真实长路径。
const longPath = (path) => realpathSync.native(path);
const samePath = (a, b) => longPath(a).toLowerCase() === longPath(b).toLowerCase();
const stripAnsi = (text) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");

export async function smokeRuntime(source, { work = tmpdir() } = {}) {
  assert.equal(process.platform, "win32", "这份冒烟要在 Windows 上跑");
  // 容器一拿到，后面的每一步（连建临时目录在内）都在同一段收尾里：哪一步失败，Job 助手都会被放开，进程能退出。
  // exercise 把建出来的 temporary / server 随手记进 held，收尾按它停、按它删。
  const job = await claimProcessJob();
  const held = {};
  let failure;
  let problems = [];
  try {
    try { await exercise(source, work, held); }
    catch (error) {
      failure = error;
      if (held.server) console.error(`--- server 输出 ---\n${held.server.output().slice(-4000)}`);
    }
    problems = await cleanUp({ ...held, job });
  } finally {
    job.release();
  }
  if (failure) {
    if (problems.length) console.error(`收尾也有问题：\n  ${problems.join("\n  ")}`);
    throw failure;
  }
  if (problems.length) throw new Error(`收尾没停干净：\n  ${problems.join("\n  ")}`);
  step("Job 里除冒烟自己外一个进程不剩，没有进程跑在临时目录里，临时目录已整个删掉");
  console.log("WINDOWS_RUNTIME_SMOKE_OK");
}

async function exercise(source, work, held) {
  const stale = reclaimScratch(work, "navi-win-smoke-");
  for (const directory of stale.removed) step(`收掉上一次被打断的冒烟留下的 ${directory}`);
  for (const line of stale.failed) console.warn(`⚠︎ 上一次冒烟留下的目录删不掉，下次再试：${line}`);
  const temporary = held.temporary = claimScratch(work, "navi-win-smoke-");
  const env = { LOCALAPPDATA: join(temporary, "LocalAppData") };
  // ── 发布：暂存 → 改名，已发布的不覆盖，清单不过不用 ──────────────────────────
  const store = runtimeStore(env);
  console.log("▶ 发布运行时（整份拷进临时 LOCALAPPDATA 再校验，上万个文件，慢的机器上要好几分钟）");
  const runtime = installRuntime(source, store, { activate: false });
  assert.equal(resolve(runtime, ".."), resolve(store));
  assert.match(basename(runtime), /^[a-f0-9]{64}$/);
  assert.equal(installRuntime(source, store, { activate: false }), runtime, "同一份运行时再发布一次应原样复用");
  assert.deepEqual(readdirSync(store).filter((name) => name.startsWith(".installing-")), []);
  const { problems, native } = scanWindowsBinaries(runtime);
  assert.deepEqual(problems, []);
  step(`发布到 ${runtime}（${native.length} 个原生文件都是 x64 PE，没有链接；重复发布原样复用）`);

  // ── 自带 node：架构、版本、文件库读写、ConPTY ────────────────────────────────
  const node = join(runtime, "node", "node.exe");
  const database = join(temporary, "probe.db");
  const probe = spawnSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    import pty from "node-pty";
    import { NAVI_MCP_SERVER_NAME } from "@navi/shared/mcp";
    assert.equal(process.arch, "x64");
    assert.ok(NAVI_MCP_SERVER_NAME);
    let db = new DatabaseSync(${JSON.stringify(database)});
    db.exec("create table probe (value text)");
    db.prepare("insert into probe values (?)").run("NAVI_SQLITE_OK");
    db.close();
    db = new DatabaseSync(${JSON.stringify(database)});
    assert.equal(db.prepare("select value from probe").get().value, "NAVI_SQLITE_OK");
    db.close();
    const output = await new Promise((resolve, reject) => {
      let output = "";
      const child = pty.spawn("cmd.exe", ["/d", "/c", "echo NAVI_%COMPUTERNAME:~0,0%PTY_OK"], { name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error("pty timeout: " + output)); }, 15000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 && output.includes("NAVI_PTY_OK") ? resolve(output) : reject(new Error(exitCode + ": " + output)); });
    });
    console.log(process.version, "sqlite+conpty");
    process.exit(0);
  `], { cwd: join(runtime, "server"), encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.equal(probe.status, 0, `${probe.error ?? ""}\n${probe.stdout}${probe.stderr}`);
  step(`自带 node ${probe.stdout.trim()}：x64、@navi/shared 经转发包加载、sqlite 写入后重开读回、ConPTY 跑 cmd 读到输出`);

  // ── server：临时数据根、非 4317 端口 ───────────────────────────────────────
  const home = join(temporary, "home");
  for (const folder of ["AppData/Roaming", "project"]) mkdirSync(join(home, folder), { recursive: true });
  const data = dataRoot(env);
  const server = held.server = await startServer({ node, runtime, dataDir: data, env: {
    ...env, USERPROFILE: home, HOME: home, APPDATA: join(home, "AppData/Roaming"),
  } });
  assert.notEqual(server.port, 4317);
  assert.ok(samePath(server.health.instance?.dataDir ?? temporary, data), `health 报的数据根不是冒烟给的那一份：${JSON.stringify(server.health.instance)}`);
  assert.ok(samePath(server.health.instance?.codeDir ?? temporary, runtime), `health 报的代码根不是发布出来的那一份：${JSON.stringify(server.health.instance)}`);
  assert.ok(existsSync(join(data, "navi.db")), "数据根里没有 navi.db");
  step(`server pid ${server.child.pid} 在 :${server.port} 报健康，代码根是发布目录，数据根 ${data}`);

  const base = `http://127.0.0.1:${server.port}/api`;
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const created = await call("/projects", { method: "POST", body: JSON.stringify({ name: "smoke", repoPath: join(home, "project") }) });
  assert.ok(created.status < 300, `建项目失败：${created.status} ${JSON.stringify(created.body)}`);
  const projectId = created.body.id;
  const listed = await call("/projects");
  assert.ok(listed.body.some((project) => project.id === projectId), "建好的项目读不回来");
  step(`经 API 写入项目 ${projectId} 并读回`);

  // ── 终端：server 自己的 ConPTY 路径（隔离 worker 里起 shell），敲一条命令读输出 ─────────
  const terminal = await call(`/projects/${projectId}/terminal/sessions`, { method: "POST", body: JSON.stringify({ cols: 120, rows: 30 }) });
  assert.equal(terminal.status, 201, `开终端失败：${JSON.stringify(terminal.body)}`);
  const sessionPath = `/projects/${projectId}/terminal/sessions/${terminal.body.id}`;
  await readTerminal(`${base}${sessionPath}/events?after=0`, async () => {
    // 回显里是带引号的表达式，只有真执行了才会出现拼起来的 NAVI_TERMINAL_OK。
    const input = await call(`${sessionPath}/input`, { method: "POST", body: JSON.stringify({ data: "echo ('NAVI_' + 'TERMINAL_OK')\r" }) });
    assert.equal(input.status, 204);
  });
  const closed = await call(sessionPath, { method: "DELETE" });
  assert.equal(closed.status, 204, `结束终端会话失败：${JSON.stringify(closed.body)}`);
  step(`终端会话 ${terminal.body.id}（${terminal.body.shell ?? "shell"}）跑出了 NAVI_TERMINAL_OK，结束会话确认整组退出`);

  // ── web ──────────────────────────────────────────────────────────────────────
  const page = await fetch(`http://127.0.0.1:${server.port}/`, { signal: AbortSignal.timeout(20_000) });
  const html = await page.text();
  assert.equal(page.status, 200);
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, "页面里没有脚本资源");
  const script = await fetch(`http://127.0.0.1:${server.port}${asset}`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(script.status, 200);
  assert.ok((await script.arrayBuffer()).byteLength > 1000);
  step(`web 页面与 ${asset} 都取得到`);
}

async function readTerminal(url, afterOpen) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let screen = "";
  let sent = null;
  // shell 画出提示符之后再敲命令，免得被它的启动清屏吞掉；迟迟认不出提示符就 8 秒后照敲。
  const send = () => { sent ??= afterOpen(); return sent; };
  const fallback = setTimeout(() => send().catch(() => {}), 8_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`终端事件流提前结束：${screen}`);
      pending += value;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === "exit") throw new Error(`终端里的 shell 退出了（${event.exitCode}）：${screen}`);
        if (event.type === "data") screen += event.data;
      }
      const visible = stripAnsi(screen);
      if (/>\s*$/.test(visible)) await send();
      if (/^\s*NAVI_TERMINAL_OK\s*$/m.test(visible)) { await sent; return screen; }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`45 秒内没在终端里读到 NAVI_TERMINAL_OK：${JSON.stringify(stripAnsi(screen).slice(-2000))}`);
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(fallback);
    controller.abort();
  }
}

// 停干净的判据是事实，不是「调过 taskkill」：
//   ① 停 server（还活着的那棵树）；
//   ② 回收 Job：容器里除自己以外的成员（脱链的后代、被超时杀掉的探针留下的孙子）全部结束，内核报只剩自己；
//   ③ 按路径再核一遍：可执行文件或命令行落在这个临时目录里的进程一个都不该有。这个目录名是随机的，命中的
//      只可能是本次冒烟起的 —— 命中了说明有进程跑出了容器，照样结束它，但这一轮算失败；
//   ④ 整个目录删得掉（Windows 上有进程开着里面的文件就删不掉）。
// 每一步各自兜底，返回所有没过的那几条。
async function cleanUp({ server, job, temporary }) {
  const problems = [];
  const attempt = async (label, work) => {
    try { await work(); } catch (error) { problems.push(`${label}：${error.message}`); }
  };
  await attempt("停 server", () => server?.stop());
  await attempt("回收 Job", () => job.reap());
  // 临时目录还没建出来就失败了：没有按路径可核的东西。
  if (!temporary) return problems;
  await attempt("核对残留", async () => {
    const escaped = processesUnder(temporary);
    if (!escaped.length) return;
    for (const line of escaped) spawnSync("taskkill", ["/PID", line.split(" ")[0], "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await delay(1000);
    throw new Error(`有进程跑出了 Job（已结束）：\n    ${escaped.join("\n    ")}${processesUnder(temporary).length ? "\n    结束之后仍在" : ""}`);
  });
  await attempt("删临时目录", () => {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    if (existsSync(temporary)) throw new Error(`${temporary} 没删掉`);
  });
  return problems;
}

function processesUnder(temporary) {
  let roots = temporary;
  try { roots = [...new Set([temporary, longPath(temporary)])].join("|"); } catch {}
  const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$roots = $env:NAVI_SMOKE_ROOTS -split '\\|'; Get-CimInstance Win32_Process | Where-Object { $p = $_; $roots | Where-Object { ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($_, 'OrdinalIgnoreCase')) -or ($p.CommandLine -and $p.CommandLine.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0) } } | ForEach-Object { \"$($_.ProcessId) $($_.Name) $($_.CommandLine)\" }"],
  { encoding: "utf8", env: { ...process.env, NAVI_SMOKE_ROOTS: roots }, windowsHide: true });
  if (query.status !== 0) throw new Error(`查不到进程表：${query.stderr}`);
  return query.stdout.split(/\r?\n/).filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, work] = process.argv.slice(2);
  if (!source) {
    console.error("usage: smoke-runtime.mjs <运行时目录> [工作目录]");
    process.exit(2);
  }
  smokeRuntime(resolve(source), work ? { work: resolve(work) } : undefined).catch((error) => { console.error(error); process.exitCode = 1; });
}
