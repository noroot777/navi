#!/usr/bin/env node
// 在开发机上把 bundle-runtime.mjs 做出的 Windows 运行时送到测试机（192.168.1.187）上跑 smoke-runtime.mjs。
//
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs [运行时目录]   # 缺省 desktop/windows/build/runtime
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --shell [便携版目录]   # 缺省 desktop/windows/build/Navi
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --install <演练载荷>   # drill-build.mjs 做的，跑 install-check.mjs
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --reclaim      # 只清上次没清完的对端目录和本机暂存
//
// --install 送的是两版演练安装包和本地更新源，在那边跑 install-check.mjs：装旧版 → 首启 → 终端里一直跑着命令 →
// 自动查到新版、点「现在更新」→ 终端没断、新壳等着 → 关终端后换到新运行时 → navi:// 三种情形 → 卸载后服务和数据还在。
// 对端目录的 <id> 是做载荷时定的（演练安装包里编进了这个目录下的 LOCALAPPDATA），从载荷的 drill.json 里取。
//
// --shell 送的是 build-shell.mjs 出的便携版（Navi.exe + runtime\），在那边用它自带的 node 跑 shell-check.mjs：
// 首启、认人、关窗、单实例转链接、壳被强杀、再打开、4317 被占（只读它的 /api/health）。
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
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, closeSession, detectLocalAddress, rexec } from "../../../scripts/win-remote/transport.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";
import { claimScratch, reclaimScratch } from "../../shared/scratch.mjs";
import { PS_DROP_TREE, reclaimPending, remember, remoteRootName, settle as settleRecord, track } from "./remote-scratch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
// 冒烟在对端要用到的脚本：它们只互相引用，不引用仓库里别的东西。
const TOOLS = [
  "desktop/shared/runtime-store.mjs", "desktop/shared/runtime-smoke.mjs", "desktop/shared/scratch.mjs",
  "desktop/windows/scripts/smoke-runtime.mjs", "desktop/windows/scripts/binary-check.mjs", "desktop/windows/scripts/layout.mjs",
  "desktop/windows/scripts/process-job.mjs", "desktop/windows/scripts/shell-check.mjs", "desktop/windows/scripts/install-check.mjs",
];
// 测试机上光是把运行时拷进发布目录就要近十分钟（上万个小文件，实测 17:24→17:34），整趟给半小时；演练要发布两版，给 80 分钟。
const TIMEOUT_MS = Number(process.env.NAVI_WIN_SMOKE_TIMEOUT_MS || (process.argv[2] === "--install" ? 80 : 30) * 60_000);
// 记账时就把目标机器定下来：回收时按账上的地址去，不看那时的环境变量。
const HOST = DEFAULT_HOST;

// 上一次被打断留下的：对端目录（账本里属主已经不在的）和本机暂存。清不掉不拦这一次，账留着；--reclaim 只做这一步。
const pending = await reclaimPending({ exec: rexec, closeSession });
for (const directory of reclaimScratch(tmpdir(), "navi-win-remote-smoke-").removed) console.log(`✓ 收掉上一次留下的本机暂存 ${directory}`);
if (process.argv[2] === "--reclaim") process.exit(pending ? 1 : 0);

const install = process.argv[2] === "--install";
const shell = process.argv[2] === "--shell";
// 送过去的那一份：冒烟是运行时目录本身，--shell 是便携版（运行时在它的 runtime\ 里），--install 是演练载荷。对端都解到 <root>\runtime。
const runtime = resolve(((shell || install) ? process.argv[3] : process.argv[2]) || join(HERE, "..", "build", shell ? "Navi" : "runtime"));
const sealed = shell ? join(runtime, "runtime") : runtime;
if (install && !existsSync(join(runtime, "drill.json"))) {
  console.error(`✕ ${runtime} 不是演练载荷：先跑 node desktop/windows/scripts/drill-build.mjs`);
  process.exit(2);
}
if (!install && (!existsSync(join(sealed, ".runtime.json")) || (shell && !existsSync(join(runtime, "Navi.exe"))))) {
  console.error(`✕ ${runtime} 不是${shell ? "便携版：先跑 node desktop/windows/scripts/build-shell.mjs" : "封好的运行时：先跑 node desktop/windows/scripts/bundle-runtime.mjs"}`);
  process.exit(2);
}


// 暂存目录、账、HTTP 服务都在下面那段 try 里才建出来，哪一步失败都走同一段 settle：建出来几样就收几样。
const id = install ? JSON.parse(readFileSync(join(runtime, "drill.json"), "utf8")).id : randomBytes(6).toString("hex");
const controller = new AbortController();
let staging;
let record;
let server;
let main;
let settling;

function settle() {
  settling ??= (async () => {
    server?.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (!record) return true;
    const result = await settleRecord(record, { exec: rexec, closeSession });
    if (result.ok) {
      console.log(`✓ 对端终端会话已关、临时目录已删，收尾后另发请求核实过：${result.detail}`);
    } else {
      console.log(`✕ 对端没结清（${result.problems.join("；")}）；账留在 ${record.file}，下次跑 remote-smoke 或 --reclaim 会先清`);
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
  staging = claimScratch(tmpdir(), "navi-win-remote-smoke-");
  record = remember({ id, host: HOST });
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
  console.log(`▶ 送 ${(size / 1024 / 1024).toFixed(1)} MB 到对端 %TEMP%\\${remoteRootName(id)}，在那边跑 ${install ? "install-check" : shell ? "shell-check" : "smoke-runtime"}.mjs`);

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

// 壳检查不能在这条通道里直接跑：对端终端会话里的进程都在一个「关掉连带结束、不许脱离」的 Job 里（实测
// LimitFlags 0x2000），壳在那里照设计拒绝起服务。用户从开始菜单、桌面、资源管理器打开时是 explorer 的 Job
// （实测 0x1800：允许脱离、不连带结束）。所以经 explorer 打开一个 .vbs，由 wscript 隐藏着跑检查，这边等它写出结束码。
// 那一路进程的命令行里同样带着目录名，清理照样认得出来。
function outsideTerminalJob(script, minutes) {
  const vbs = [
    `Set sh = CreateObject("WScript.Shell")`,
    // explorer 打开文件时不带参数：目录就是脚本自己所在的那个。
    `root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)`,
    `q = Chr(34)`,
    // 壳检查用便携版自带的 node；演练用对端系统里的 node（载荷里没有运行时，装上去之前也没有）。
    `node = ${script === "shell-check" ? `q & root & "\\runtime\\runtime\\node\\node.exe" & q` : `"node"`}`,
    `cmd = "cmd /d /c " & q & node & " " & q & root & "\\tools\\desktop\\windows\\scripts\\${script}.mjs" & q & " " & q & root & "\\runtime" & q & " " & q & root & "\\work" & q & " > " & q & root & "\\check.log" & q & " 2>&1" & q`,
    `code = sh.Run(cmd, 0, True)`,
    `Set f = CreateObject("Scripting.FileSystemObject").CreateTextFile(root & "\\check.done", True)`,
    `f.Write code`,
    `f.Close`,
  ].join("\r\n");
  return [
    `  $vbs = Join-Path $root 'check.vbs'`,
    `  [IO.File]::WriteAllText($vbs, ${psq(vbs)}, [Text.Encoding]::ASCII)`,
    `  $done = Join-Path $root 'check.done'`,
    `  & explorer.exe $vbs`,
    `  $deadline = (Get-Date).AddMinutes(${minutes})`,
    `  while (-not (Test-Path -LiteralPath $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }`,
    `  $log = Join-Path $root 'check.log'`,
    `  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { "$_" } }`,
    `  if (-not (Test-Path -LiteralPath $done)) { Write-Output '✕ ${minutes} 分钟内检查没跑完'; exit 1 }`,
    `  $global:LASTEXITCODE = [int](Get-Content -LiteralPath $done -Raw).Trim()`,
  ];
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
    ...(shell || install ? outsideTerminalJob(install ? "install-check" : "shell-check", Math.round(TIMEOUT_MS / 60_000) - 2) : [
      `  node (Join-Path $root 'tools\\desktop\\windows\\scripts\\smoke-runtime.mjs') (Join-Path $root 'runtime') $work 2>&1 | ForEach-Object { "$_" }`,
    ]),
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
