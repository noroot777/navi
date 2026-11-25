// 远程冒烟在对端留下的东西归开发机这一侧管，不归对端那条可能被强杀的命令管。
//
// 对端命令自己的 finally 管不住三种结局：rexec 期限到了、把对端整棵进程树（连同那段 finally）一刀切掉；
// 开发机这头被 Ctrl-C / 杀掉；网络断了。所以目录名（<id>）由开发机生成，送命令之前先记进本机的账本
// （~/.cache/navi/win-remote-smoke/<id>.json），命令不论怎么结束，都另起一次结算。账本放在仓库之外：worktree
// 验收后就删了，账得活得比它久。
//
// 一条账记三样责任，分开结算，**全部核实了才销账**，任何一样没核实就留着、下一次 remote-smoke（或 --reclaim）重来：
//   · 终端会话：主命令的、每次清理请求自己的。rexec 自己删会话失败会吞掉，所以会话一建好就记账，事后逐个
//     关掉（404 也算关掉）；
//   · 目录里的进程：命令行或可执行文件路径带目录名的，结束掉、再查一遍；进程表查不出来不等于「查到 0 个」；
//   · 目录本身：删掉并核实不在了。
//
// 账本只认**完整、校验过**的记录：写入走「临时文件 + 改名」，读的人永远看不到写了一半的文件；读不出来、
// 缺字段的一律当「身份未知」，报出来、原样留着，绝不据此去结束进程或删目录。目标机器按记账时解析出的
// 地址记下，回收时不按当时的环境变量去猜。
//
// 一条账**同一时刻只有一个持有者**，持有者写在文件名上：属主自己记的账是 `<id>.json`（持有者 = 记录里的
// owner）；属主不在了，回收者先把它**改名**认领成 `<id>.claim-<自己的 pid>.json` —— 改名是原子的，几个回收者
// 同时认领只有一个成功，其余的拿到 ENOENT 就走开。之后的每次写入、最后的销账都只碰自己认领到的那个文件，
// 别人手里的快照覆盖不了它、也销不掉它。认领者自己又被杀了，下一个回收者照样按文件名里的 pid 认出来、再认领。
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive } from "../../shared/scratch.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";

export const journalDir = () => process.env.NAVI_WIN_REMOTE_JOURNAL || join(homedir(), ".cache", "navi", "win-remote-smoke");
export const journalFile = (id) => join(journalDir(), `${id}.json`);
const claimFile = (id, pid) => join(journalDir(), `${id}.claim-${pid}.json`);
export const remoteRootName = (id) => `navi-win-runtime-${id}`;
const ID = /^[a-f0-9]{12}$/;
const ENTRY = /^([a-f0-9]{12})(?:\.claim-(\d+))?\.json$/;
const PARTIAL = /^[a-f0-9]{12}(?:\.claim-\d+)?\.json\.(\d+)\.tmp$/;

// 记录对象上的 file 是「我手里这一份在哪」，不写进文件。
function save(record) {
  mkdirSync(journalDir(), { recursive: true });
  const partial = `${record.file}.${process.pid}.tmp`;
  const { file, ...body } = record;
  writeFileSync(partial, JSON.stringify(body));
  renameSync(partial, file);
}

/** 送命令之前调用：记下这次要在对端建的目录、目标机器（解析好的地址）和属主（当前进程）。返回这条记录。 */
export function remember({ id, host }) {
  if (!ID.test(id)) throw new Error(`对端目录 id 不合规：${id}`);
  if (typeof host !== "string" || !/^https?:\/\//.test(host)) throw new Error(`对端地址不合规：${host}`);
  const record = { id, host, owner: process.pid, sessions: [], createdAt: new Date().toISOString(), file: journalFile(id) };
  save(record);
  return record;
}

/** 会话一建好就调用：先记账再干活，开发机这头随时被杀，这个会话也有人认领。 */
export function track(record, { projectId, sessionId }) {
  if (!record.sessions.some((session) => session.sessionId === sessionId)) record.sessions.push({ projectId, sessionId });
  save(record);
}

/** 销账：只删自己手里那一份。 */
export function forget(record) {
  rmSync(record.file, { force: true });
}

function validated(record, id) {
  if (!record || record.id !== id) throw new Error("id 对不上文件名");
  if (!Number.isInteger(record.owner) || record.owner <= 0) throw new Error("没有属主");
  if (typeof record.host !== "string" || !/^https?:\/\//.test(record.host)) throw new Error("没有目标机器");
  if (!Array.isArray(record.sessions) || !record.sessions.every((s) => typeof s?.projectId === "string" && typeof s?.sessionId === "string")) {
    throw new Error("会话记录不完整");
  }
  return record;
}

function read(file, id) {
  return validated(JSON.parse(readFileSync(file, "utf8")), id);
}

/**
 * 列出账本：完整的给出记录和它的持有者（holder），读不出或缺字段的给 { id, file, unknown }（不授权任何清理）。
 * 这只是一份快照：要动哪一条，先 claim。
 */
export function records() {
  let names = [];
  try { names = readdirSync(journalDir()); } catch { return []; }
  for (const name of names) {
    // 写到一半就被杀掉的临时文件：写它的进程已经不在了，删掉（正式记录要么还是旧的，要么根本没写成）。
    const partial = PARTIAL.exec(name);
    if (partial && !processAlive(Number(partial[1]))) rmSync(join(journalDir(), name), { force: true });
  }
  return names.flatMap((name) => {
    const match = ENTRY.exec(name);
    if (!match) return [];
    const [, id, claimant] = match;
    const file = join(journalDir(), name);
    try {
      const record = read(file, id);
      return [{ ...record, file, holder: claimant ? Number(claimant) : record.owner }];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      return [{ id, file, unknown: error.message }];
    }
  });
}

/**
 * 认领一条持有者已经不在的账：改名成自己的认领文件，改名成功的那一个才算持有；别人先认领走了返回 null。
 * 认领后从自己那份重读（快照可能过时），属主改成自己再写回。
 */
export function claim(entry) {
  const target = claimFile(entry.id, process.pid);
  try { renameSync(entry.file, target); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = { ...read(target, entry.id), file: target };
  record.owner = process.pid;
  save(record);
  return record;
}

// 删一整棵目录树。不能用 Remove-Item：Windows PowerShell 5.1 删不了超过 260 字符的路径，而冒烟中途被切时
// 目录里留着发布到一半的运行时（%TEMP%\navi-win-runtime-<id>\work\…\runtimes\<sha256>\…，实测最长 292）。
// 加 \\?\ 前缀交给 .NET 删；它不行再用 rd 删一次。
export const PS_DROP_TREE = String.raw`function Drop-Tree($path) { if (-not (Test-Path -LiteralPath $path)) { return }; try { [IO.Directory]::Delete('\\?\' + $path, $true) } catch { }; if (Test-Path -LiteralPath $path) { cmd.exe /d /c ('rd /s /q "\\?\' + $path + '"') 2>$null | Out-Null } }`;

/**
 * 对端清理命令：结束名字里带这个目录名的进程 → 删目录 → 删当前用户名下指着这个目录的 Navi 登记 → 过一秒再核一遍，
 * 都没了才报 ROOT_GONE。登记那一步是给 install-check 兜底的：它被结束在半路就走不到自己的收尾，装上的卸载项、
 * navi://、厂商键、登录项、开始菜单和桌面快捷方式会一直留着、还指着已经删掉的目录（下一次演练开头因此拒绝跑）。
 * 只删值里带这个目录名的，跟 install-check 收尾同一条规矩；别的 Navi 登记一项都不碰。
 * 进程表要真查出来：Get-CimInstance 出错（WMI 服务卡住之类）时拿到的是空结果，不能当成「一个都没有」。
 */
export function cleanupCommand(id) {
  const name = remoteRootName(id);
  return [
    `$name = ${psq(name)}`,
    `$root = Join-Path $env:TEMP $name`,
    `$existed = Test-Path -LiteralPath $root`,
    PS_DROP_TREE,
    `$script:queryError = $null`,
    // 目录名里有 12 位随机 hex，命中的只可能是这次冒烟起的：下载用的 curl、解包的 tar、跑冒烟的 node、包里的 node.exe……
    `function Hits { try { $all = Get-CimInstance Win32_Process -ErrorAction Stop } catch { $script:queryError = $_.Exception.Message; return }; @($all | Where-Object { $_.ProcessId -ne $PID -and (($_.CommandLine -and $_.CommandLine.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.ExecutablePath -and $_.ExecutablePath.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0)) }) }`,
    `$killed = 0`,
    `$deadline = (Get-Date).AddSeconds(45)`,
    `while ($true) {`,
    `  $hits = Hits`,
    `  if ($script:queryError) { break }`,
    `  foreach ($p in $hits) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }`,
    `  Drop-Tree $root`,
    `  if ($hits.Count -eq 0 -and -not (Test-Path -LiteralPath $root)) { break }`,
    `  if ((Get-Date) -gt $deadline) { break }`,
    `  Start-Sleep -Milliseconds 500`,
    `}`,
    `function Into([string]$value) { return $value -and $value.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 }`,
    `function Registrations {`,
    `  $found = @()`,
    `  $u = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Navi'; if ((Test-Path $u) -and (Into (Get-ItemProperty $u).UninstallString)) { $found += $u }`,
    `  $c = 'HKCU:\\Software\\Classes\\navi'; if ((Test-Path "$c\\shell\\open\\command") -and (Into (Get-ItemProperty "$c\\shell\\open\\command").'(default)')) { $found += $c }`,
    `  $v = 'HKCU:\\Software\\Navi'; if ((Test-Path "$v\\Navi") -and @(Get-ChildItem $v).Count -eq 1 -and @((Get-Item $v).Property).Count -eq 0 -and (Into (Get-ItemProperty "$v\\Navi").'(default)')) { $found += $v }`,
    `  $r = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if ((Test-Path $r) -and (Into (Get-ItemProperty $r).Navi)) { $found += "$r|Navi" }`,
    `  $shell = New-Object -ComObject WScript.Shell`,
    `  foreach ($link in (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Navi.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Navi.lnk')) { if ((Test-Path -LiteralPath $link) -and (Into $shell.CreateShortcut($link).TargetPath)) { $found += $link } }`,
    `  return $found`,
    `}`,
    `$unregistered = 0`,
    `foreach ($item in @(Registrations)) {`,
    `  try { if ($item -like '*|Navi') { Remove-ItemProperty ($item -replace '\\|Navi$', '') -Name Navi -Force -ErrorAction Stop } else { Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction Stop }; $unregistered++ } catch { }`,
    `}`,
    // 刚被结束的那条命令可能正走到自己的收尾、又碰了一下目录：隔一秒再看一眼才下结论。
    `Start-Sleep -Milliseconds 1000`,
    `$left = Hits`,
    `$registered = @(Registrations)`,
    `if ($registered.Count) { Write-Output ("ROOT_LEFT " + $root + " 登记还在：" + ($registered -join ',')); exit 1 }`,
    `if ($script:queryError) { Write-Output ("ROOT_LEFT " + $root + " 进程表查不出来：" + $script:queryError); exit 1 }`,
    `if ((Test-Path -LiteralPath $root) -or $left.Count) { Write-Output ("ROOT_LEFT " + $root + " exists=" + (Test-Path -LiteralPath $root) + " procs=" + (($left | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ',')); exit 1 }`,
    `Write-Output ("ROOT_GONE " + $root + " existed=" + $existed + " killed=" + $killed + " unregistered=" + $unregistered)`,
  ].join("\n");
}

/** 发清理命令并认 ROOT_GONE；清理请求自己的会话也记账。连不上或没清干净就隔几秒再试，几次都不行返回 { ok: false }。 */
export async function cleanRemote(record, { exec, attempts = 3, pause = 5_000 }) {
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await exec(cleanupCommand(record.id), { timeout: 90_000, host: record.host, onSession: (session) => track(record, session) });
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

/** 逐个关掉账上的会话（404 算关掉），关掉一个销一个；返回没关掉的那几条。 */
async function closeSessions(record, closeSession) {
  const problems = [];
  for (const session of [...record.sessions]) {
    try {
      await closeSession({ ...session, host: record.host });
      record.sessions = record.sessions.filter((other) => other.sessionId !== session.sessionId);
      save(record);
    } catch (error) {
      problems.push(`终端会话 ${session.sessionId} 没关掉：${error.message}`);
    }
  }
  return problems;
}

/**
 * 结算一条账：先关会话（主命令还在跑的话，它连同进程树随会话结束），再清目录和进程，最后把清理请求
 * 自己的会话也关掉。三样都核实了才销账；返回 { ok, detail, problems }。
 */
export async function settle(record, { exec, closeSession, attempts, pause }) {
  const problems = await closeSessions(record, closeSession);
  const remote = await cleanRemote(record, { exec, attempts, pause });
  if (!remote.ok) problems.push(`对端目录：${remote.detail}`);
  const late = await closeSessions(record, closeSession);
  const all = [...new Set([...problems, ...late])];
  if (!all.length) forget(record);
  return { ok: !all.length, detail: remote.detail, problems: all };
}

/** 替属主已经不在的记录结算；返回没结清的条数（账留着，下次再来）。身份不明的记录只报、不动。 */
export async function reclaimPending({ exec, closeSession, log = console.log, attempts, pause }) {
  let failures = 0;
  for (const record of records()) {
    if (record.unknown) {
      failures++;
      log(`✕ 账本记录 ${record.file} 读不出完整身份（${record.unknown}），原样留着、不去碰对端；确认无用后手动删掉它`);
      continue;
    }
    if (record.holder === process.pid || processAlive(record.holder)) continue;
    let claimed;
    try { claimed = claim(record); }
    catch (error) {
      failures++;
      log(`✕ 认领 ${record.file} 失败（${error.message}），原样留着`);
      continue;
    }
    if (!claimed) continue;
    const result = await settle(claimed, { exec, closeSession, attempts, pause });
    if (result.ok) {
      log(`✓ 结清上一次留下的对端会话与目录：${result.detail}`);
    } else {
      failures++;
      log(`✕ 上一次留下的 ${remoteRootName(record.id)} 没结清（${result.problems.join("；")}），账留在 ${claimed.file}`);
    }
  }
  return failures;
}
