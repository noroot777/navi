// 远程冒烟在对端留下的 %TEMP%\navi-win-runtime-<id>\ 归开发机这一侧管，不归对端那条可能被强杀的命令管。
//
// 对端命令自己的 finally 管不住三种结局：rexec 期限到了、把对端整棵进程树（连同那段 finally）一刀切掉；
// 开发机这头被 Ctrl-C / 杀掉；网络断了。所以目录名（<id>）由开发机生成，送命令之前先把它记进本机的账本
// （~/.cache/navi/win-remote-smoke/<id>.json），命令不论怎么结束，都另发一次独立请求：结束名字里带 <id> 的
// 进程、删目录、核实两样都没了，才把账销掉。清不掉（对端不可达）就留着账，下一次 remote-smoke（或 --reclaim）
// 开头先替它清。账本放在仓库之外：worktree 验收后就删了，账得活得比它久。
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive } from "../../shared/scratch.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";

export const journalDir = () => process.env.NAVI_WIN_REMOTE_JOURNAL || join(homedir(), ".cache", "navi", "win-remote-smoke");
export const journalFile = (id) => join(journalDir(), `${id}.json`);
export const remoteRootName = (id) => `navi-win-runtime-${id}`;

/** 送命令之前调用：记下这次要在对端建的目录（属主是当前进程）；会话建好后再带上 session 记一次。 */
export function remember({ id, host, session }) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error(`对端目录 id 不合规：${id}`);
  mkdirSync(journalDir(), { recursive: true });
  writeFileSync(journalFile(id), JSON.stringify({ id, host, session, owner: process.pid, createdAt: new Date().toISOString() }));
}

export function forget(id) {
  rmSync(journalFile(id), { force: true });
}

export function records() {
  let names = [];
  try { names = readdirSync(journalDir()).filter((name) => /^[a-f0-9]{12}\.json$/.test(name)); } catch { return []; }
  return names.map((name) => {
    try { return JSON.parse(readFileSync(join(journalDir(), name), "utf8")); }
    catch { return { id: name.slice(0, 12), owner: 0 }; }
  });
}

// 删一整棵目录树。不能用 Remove-Item：Windows PowerShell 5.1 删不了超过 260 字符的路径，而冒烟中途被切时
// 目录里留着发布到一半的运行时（%TEMP%\navi-win-runtime-<id>\work\…\runtimes\<sha256>\…，实测最长 292）。
// 加 \\?\ 前缀交给 .NET 删；它不行再用 rd 删一次。
export const PS_DROP_TREE = String.raw`function Drop-Tree($path) { if (-not (Test-Path -LiteralPath $path)) { return }; try { [IO.Directory]::Delete('\\?\' + $path, $true) } catch { }; if (Test-Path -LiteralPath $path) { cmd.exe /d /c ('rd /s /q "\\?\' + $path + '"') 2>$null | Out-Null } }`;

/** 对端清理命令：结束名字里带这个目录名的进程 → 删目录 → 过一秒再核一遍，两样都没了才报 ROOT_GONE。 */
export function cleanupCommand(id) {
  const name = remoteRootName(id);
  return [
    `$name = ${psq(name)}`,
    `$root = Join-Path $env:TEMP $name`,
    `$existed = Test-Path -LiteralPath $root`,
    PS_DROP_TREE,
    // 目录名里有 12 位随机 hex，命中的只可能是这次冒烟起的：下载用的 curl、解包的 tar、跑冒烟的 node、包里的 node.exe……
    `function Hits { @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.CommandLine -and $_.CommandLine.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0)) }) }`,
    `$killed = 0`,
    `$deadline = (Get-Date).AddSeconds(45)`,
    `while ($true) {`,
    `  $hits = Hits`,
    `  foreach ($p in $hits) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }`,
    `  Drop-Tree $root`,
    `  if ($hits.Count -eq 0 -and -not (Test-Path -LiteralPath $root)) { break }`,
    `  if ((Get-Date) -gt $deadline) { break }`,
    `  Start-Sleep -Milliseconds 500`,
    `}`,
    // 刚被结束的那条命令可能正走到自己的收尾、又碰了一下目录：隔一秒再看一眼才下结论。
    `Start-Sleep -Milliseconds 1000`,
    `$left = Hits`,
    `if ((Test-Path -LiteralPath $root) -or $left.Count) { Write-Output ("ROOT_LEFT " + $root + " exists=" + (Test-Path -LiteralPath $root) + " procs=" + (($left | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ',')); exit 1 }`,
    `Write-Output ("ROOT_GONE " + $root + " existed=" + $existed + " killed=" + $killed)`,
  ].join("\n");
}

/** 发清理命令并认 ROOT_GONE；连不上或没清干净就隔几秒再试，几次都不行返回 { ok: false }。 */
export async function cleanRemote(id, { exec, host, attempts = 3, pause = 5_000 }) {
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await exec(cleanupCommand(id), { timeout: 90_000, ...(host ? { host } : {}) });
      const line = result.out.split(/\r?\n/).find((text) => /^ROOT_(GONE|LEFT)\b/.test(text.trim()))?.trim();
      if (result.code === 0 && line?.startsWith("ROOT_GONE")) return { ok: true, detail: line };
      detail = line || result.out.trim().slice(-500) || `退出码 ${result.code}`;
    } catch (error) {
      detail = error.message;
    }
    if (attempt < attempts) await delay(pause);
  }
  return { ok: false, detail };
}

/**
 * 替属主已经不在的记录清对端；返回清不掉的条数（账留着，下次再来）。属主是被 kill -9 的，它那条命令的终端会话
 * 也还开着：先删会话（里面那条命令连同它的进程树随之结束），再清目录。
 */
export async function reclaimPending({ exec, closeSession, log = console.log, attempts, pause }) {
  let failures = 0;
  for (const record of records()) {
    if (record.owner === process.pid || processAlive(record.owner)) continue;
    if (record.session) {
      try {
        await closeSession({ ...record.session, ...(record.host ? { host: record.host } : {}) });
        log(`✓ 删掉上一次留下的终端会话 ${record.session.sessionId}`);
      }
      catch (error) { log(`⚠︎ 上一次的终端会话 ${record.session.sessionId} 没删掉（${error.message}），接着清目录`); }
    }
    const result = await cleanRemote(record.id, { exec, host: record.host, attempts, pause });
    if (result.ok) {
      forget(record.id);
      log(`✓ 收掉上一次没清完的对端目录：${result.detail}`);
    } else {
      failures++;
      log(`✕ 上一次留下的对端目录 ${remoteRootName(record.id)} 仍没清掉（${result.detail}），账留在 ${journalFile(record.id)}`);
    }
  }
  return failures;
}
