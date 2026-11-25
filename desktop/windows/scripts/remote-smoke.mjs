#!/usr/bin/env node
// 在开发机上把 bundle-runtime.mjs 做出的 Windows 运行时送到测试机（192.168.1.187）上跑 smoke-runtime.mjs。
//
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs [运行时目录]   # 缺省 desktop/windows/build/runtime
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --reclaim      # 只清上次没清完的对端目录
//
// 通道是 scripts/win-remote 的那套（对端 Navi 的终端 API，见 docs/win-remote.md）。运行时有一两百 MB、不进 git，
// 所以不走 win-remote sync：这边打一个 tar.gz、起一个只活这一次的 HTTP 服务（随机端口 + 随机路径），对端
// curl.exe 拉下来、用自带的 tar 解开。对端的一切都落在 %TEMP%\navi-win-runtime-<id>\ 里（冒烟的工作目录也在
// 里面），不进对端仓库、不碰它的 worktree，也不碰它 :4317 上正在用的那份 Navi。
//
// 这个目录归开发机这一侧管（remote-scratch.mjs）：<id> 由这边生成、送命令前先记账；命令跑完、超时被切、
// 这边被 Ctrl-C，都另发一次请求结束目录里的进程、删目录并核实，核实了才销账。清不掉就留账，下次开头先清。
// 真正干活的那段落成目录里的 run.ps1、由单独一个 powershell 跑：它和它起的一切命令行里都带着目录名，清理时认得出来。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, closeSession, detectLocalAddress, rexec } from "../../../scripts/win-remote/transport.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";
import { claimScratch, reclaimScratch } from "../../shared/scratch.mjs";
import { PS_DROP_TREE, journalFile, reclaimPending, remember, remoteRootName, settle as settleRecord, track } from "./remote-scratch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
// 冒烟在对端要用到的脚本：它们只互相引用，不引用仓库里别的东西。
const TOOLS = [
  "desktop/shared/runtime-store.mjs", "desktop/shared/runtime-smoke.mjs", "desktop/shared/scratch.mjs",
  "desktop/windows/scripts/smoke-runtime.mjs", "desktop/windows/scripts/binary-check.mjs", "desktop/windows/scripts/layout.mjs",
  "desktop/windows/scripts/process-job.mjs",
];
// 测试机上光是把运行时拷进发布目录就要近十分钟（上万个小文件，实测 17:24→17:34），整趟给半小时。
const TIMEOUT_MS = Number(process.env.NAVI_WIN_SMOKE_TIMEOUT_MS || 30 * 60_000);
// 记账时就把目标机器定下来：回收时按账上的地址去，不看那时的环境变量。
const HOST = DEFAULT_HOST;

if (process.argv[2] === "--reclaim") {
  process.exit((await reclaimPending({ exec: rexec, closeSession })) ? 1 : 0);
}

const runtime = resolve(process.argv[2] || join(HERE, "..", "build", "runtime"));
if (!existsSync(join(runtime, ".runtime.json"))) {
  console.error(`✕ ${runtime} 不是封好的运行时：先跑 node desktop/windows/scripts/bundle-runtime.mjs`);
  process.exit(2);
}

// 上一次被打断留下的：对端目录（账本里属主已经不在的）和本机暂存。清不掉不拦这一次，账留着。
await reclaimPending({ exec: rexec, closeSession });
for (const directory of reclaimScratch(tmpdir(), "navi-win-remote-smoke-").removed) console.log(`✓ 收掉上一次留下的本机暂存 ${directory}`);

const id = randomBytes(6).toString("hex");
const staging = claimScratch(tmpdir(), "navi-win-remote-smoke-");
const record = remember({ id, host: HOST });
const controller = new AbortController();
let server;
let main;
let settling;

function settle() {
  settling ??= (async () => {
    server?.close();
    rmSync(staging, { recursive: true, force: true });
    const result = await settleRecord(record, { exec: rexec, closeSession });
    if (result.ok) {
      console.log(`✓ 对端终端会话已关、临时目录已删，收尾后另发请求核实过：${result.detail}`);
    } else {
      console.log(`✕ 对端没结清（${result.problems.join("；")}）；账留在 ${journalFile(id)}，下次跑 remote-smoke 或 --reclaim 会先清`);
    }
    return result.ok;
  })();
  return settling;
}

// 第一下 Ctrl-C：中止那条命令（rexec 删掉终端会话，对端整棵树跟着走），清完对端再退；再按一下就直接退，账还在。
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(name, () => {
    console.error(`▶ 收到 ${name}：先收掉对端那条命令和临时目录再退`);
    controller.abort();
    (async () => {
      await main?.catch(() => {});
      await settle();
      process.exit(130);
    })();
  });
}

try {
  const payload = join(staging, "payload");
  cpSync(runtime, join(payload, "runtime"), { recursive: true });
  for (const tool of TOOLS) {
    mkdirSync(dirname(join(payload, "tools", tool)), { recursive: true });
    cpSync(join(REPO, tool), join(payload, "tools", tool));
  }
  const bundle = join(staging, "bundle.tgz");
  const packed = spawnSync("tar", ["-czf", bundle, "-C", payload, "runtime", "tools"], { stdio: "inherit" });
  if (packed.status !== 0) throw new Error("打包失败");
  const size = statSync(bundle).size;

  const secret = randomBytes(12).toString("hex");
  server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${secret}/bundle.tgz`) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "application/gzip", "content-length": size });
    createReadStream(bundle).pipe(response);
  });
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const url = `http://${detectLocalAddress()}:${server.address().port}/${secret}/bundle.tgz`;
  console.log(`▶ 送 ${(size / 1024 / 1024).toFixed(1)} MB 到对端 %TEMP%\\${remoteRootName(id)}，在那边跑 smoke-runtime.mjs`);

  main = rexec(remoteCommand(id, url), {
    timeout: TIMEOUT_MS, signal: controller.signal, host: HOST, onSession: (session) => track(record, session),
  });
  const result = await main;
  console.log(result.out.trim());
  console.log(`[exit ${result.code}]`);
  process.exitCode = result.code === 0 ? 0 : 1;
} catch (error) {
  console.error(`✕ ${error.message}`);
  process.exitCode = 1;
} finally {
  if (!controller.signal.aborted && !(await settle())) process.exitCode = 1;
}

function remoteCommand(id, url) {
  const run = [
    `param([string]$root)`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `try {`,
    `  $bundle = Join-Path $root 'bundle.tgz'`,
    `  curl.exe -fsS -o $bundle ${psq(url)}`,
    `  if ($LASTEXITCODE -ne 0) { throw "下载失败（curl 退出码 $LASTEXITCODE）" }`,
    `  tar.exe -xzf $bundle -C $root`,
    `  if ($LASTEXITCODE -ne 0) { throw "解包失败（tar 退出码 $LASTEXITCODE）" }`,
    `  Remove-Item -LiteralPath $bundle -Force`,
    `  Write-Output ("harness node " + (node -v) + "  on " + [Environment]::OSVersion.VersionString)`,
    `  $work = Join-Path $root 'work'`,
    `  New-Item -ItemType Directory -Path $work | Out-Null`,
    `  node (Join-Path $root 'tools\\desktop\\windows\\scripts\\smoke-runtime.mjs') (Join-Path $root 'runtime') $work 2>&1 | ForEach-Object { "$_" }`,
    `  exit $LASTEXITCODE`,
    `} catch { Write-Output ("✕ " + $_.Exception.Message); exit 1 }`,
  ].join("\n");
  return [
    `$root = Join-Path $env:TEMP ${psq(remoteRootName(id))}`,
    `New-Item -ItemType Directory -Path $root -Force | Out-Null`,
    `$run = Join-Path $root 'run.ps1'`,
    // 带 BOM：Windows PowerShell 5.1 读无 BOM 的脚本按活动代码页解，里面的中文会坏（同 transport.mjs）。
    `[IO.File]::WriteAllText($run, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(Buffer.from(run, "utf8").toString("base64"))})), (New-Object Text.UTF8Encoding $true))`,
    `& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $run $root 2>&1 | ForEach-Object { "$_" }`,
    `$code = $LASTEXITCODE`,
    // 正常结束顺手删一次；删没删掉、被切掉时留没留下，由开发机那头另发请求核实。
    PS_DROP_TREE,
    `Drop-Tree $root`,
    `exit $code`,
  ].join("\n");
}
