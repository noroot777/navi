#!/usr/bin/env node
// 在开发机上把 bundle-runtime.mjs 做出的 Windows 运行时送到测试机（192.168.1.187）上跑 smoke-runtime.mjs。
//
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs [运行时目录]   # 缺省 desktop/windows/build/runtime
//
// 通道是 scripts/win-remote 的那套（对端 Navi 的终端 API，见 docs/win-remote.md）。运行时有一两百 MB、不进 git，
// 所以不走 win-remote sync：这边打一个 tar.gz、起一个只活这一次的 HTTP 服务（随机端口 + 随机路径），对端
// curl.exe 拉下来、用自带的 tar 解开。对端的一切都落在 %TEMP%\navi-win-runtime-<随机>\ 里，跑完连同冒烟自己
// 的临时目录一起删掉 —— 不进对端仓库、不碰它的 worktree，也不碰它 :4317 上正在用的那份 Navi。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectLocalAddress, rexec } from "../../../scripts/win-remote/transport.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
// 冒烟在对端要用到的脚本：它们只互相引用，不引用仓库里别的东西。
const TOOLS = [
  "desktop/shared/runtime-store.mjs", "desktop/shared/runtime-smoke.mjs",
  "desktop/windows/scripts/smoke-runtime.mjs", "desktop/windows/scripts/binary-check.mjs", "desktop/windows/scripts/layout.mjs",
];

const runtime = resolve(process.argv[2] || join(HERE, "..", "build", "runtime"));
if (!existsSync(join(runtime, ".runtime.json"))) {
  console.error(`✕ ${runtime} 不是封好的运行时：先跑 node desktop/windows/scripts/bundle-runtime.mjs`);
  process.exit(2);
}

const staging = mkdtempSync(join(tmpdir(), "navi-win-remote-smoke-"));
let server;
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
  console.log(`▶ 送 ${(size / 1024 / 1024).toFixed(1)} MB 到对端，在那边跑 smoke-runtime.mjs`);

  const command = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$root = Join-Path $env:TEMP ('navi-win-runtime-' + [guid]::NewGuid().ToString('N').Substring(0, 12))`,
    `New-Item -ItemType Directory -Path $root | Out-Null`,
    `$code = 1`,
    `try {`,
    `  $bundle = Join-Path $root 'bundle.tgz'`,
    `  curl.exe -fsS -o $bundle ${psq(url)}`,
    `  if ($LASTEXITCODE -ne 0) { throw "下载失败（curl 退出码 $LASTEXITCODE）" }`,
    `  tar.exe -xzf $bundle -C $root`,
    `  if ($LASTEXITCODE -ne 0) { throw "解包失败（tar 退出码 $LASTEXITCODE）" }`,
    `  Remove-Item -LiteralPath $bundle -Force`,
    `  Write-Output ("harness node " + (node -v) + "  on " + [Environment]::OSVersion.VersionString)`,
    `  node (Join-Path $root 'tools\\desktop\\windows\\scripts\\smoke-runtime.mjs') (Join-Path $root 'runtime') 2>&1 | ForEach-Object { "$_" }`,
    `  $code = $LASTEXITCODE`,
    `} catch { Write-Output ("✕ " + $_.Exception.Message) }`,
    `finally {`,
    `  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue`,
    `  if (Test-Path -LiteralPath $root) { Write-Output "✕ 对端临时目录没删掉：$root"; $code = 1 } else { Write-Output "✓ 对端临时目录已删：$root" }`,
    `}`,
    `exit $code`,
  ].join("\n");
  const result = await rexec(command, { timeout: 10 * 60_000 });
  console.log(result.out.trim());
  console.log(result.code === 0 ? "[exit 0]" : `[exit ${result.code}]`);
  process.exitCode = result.code === 0 ? 0 : 1;
} catch (error) {
  console.error(`✕ ${error.message}`);
  process.exitCode = 1;
} finally {
  server?.close();
  rmSync(staging, { recursive: true, force: true });
}
