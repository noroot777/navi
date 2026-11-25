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
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive } from "../../shared/scratch.mjs";
import { psq } from "../../../scripts/win-remote/ps.mjs";

export const journalDir = () => process.env.NAVI_WIN_REMOTE_JOURNAL || join(homedir(), ".cache", "navi", "win-remote-smoke");
export const journalFile = (id) => join(journalDir(), `${id}.json`);
export const remoteRootName = (id) => `navi-win-runtime-${id}`;
const ID = /^[a-f0-9]{12}$/;

function save(record) {
  mkdirSync(journalDir(), { recursive: true });
  const partial = `${journalFile(record.id)}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(record));
  renameSync(partial, journalFile(record.id));
}

/** 送命令之前调用：记下这次要在对端建的目录、目标机器（解析好的地址）和属主（当前进程）。返回这条记录。 */
export function remember({ id, host }) {
  if (!ID.test(id)) throw new Error(`对端目录 id 不合规：${id}`);
  if (typeof host !== "string" || !/^https?:\/\//.test(host)) throw new Error(`对端地址不合规：${host}`);
  const record = { id, host, owner: process.pid, sessions: [], createdAt: new Date().toISOString() };
  save(record);
  return record;
}

/** 会话一建好就调用：先记账再干活，开发机这头随时被杀，这个会话也有人认领。 */
export function track(record, { projectId, sessionId }) {
  if (!record.sessions.some((session) => session.sessionId === sessionId)) record.sessions.push({ projectId, sessionId });
  save(record);
}

export function forget(id) {
  rmSync(journalFile(id), { force: true });
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

/** 列出账本：完整的给出记录，读不出或缺字段的给 { id, unknown }（不授权任何清理）。 */
export function records() {
  let names = [];
  try { names = readdirSync(journalDir()); } catch { return []; }
  for (const name of names) {
    // 写到一半就被杀掉的临时文件：写它的进程已经不在了，删掉（正式记录要么还是旧的，要么根本没写成）。
    const partial = /^[a-f0-9]{12}\.json\.(\d+)\.tmp$/.exec(name);
    if (partial && !processAlive(Number(partial[1]))) rmSync(join(journalDir(), name), { force: true });
  }
  return names.filter((name) => /^[a-f0-9]{12}\.json$/.test(name)).map((name) => {
    const id = name.slice(0, 12);
    try { return validated(JSON.parse(readFileSync(join(journalDir(), name), "utf8")), id); }
    catch (error) { return { id, unknown: error.message }; }
  });
}

// 删一整棵目录树。不能用 Remove-Item：Windows PowerShell 5.1 删不了超过 260 字符的路径，而冒烟中途被切时
// 目录里留着发布到一半的运行时（%TEMP%\navi-win-runtime-<id>\work\…\runtimes\<sha256>\…，实测最长 292）。
// 加 \\?\ 前缀交给 .NET 删；它不行再用 rd 删一次。
export const PS_DROP_TREE = String.raw`function Drop-Tree($path) { if (-not (Test-Path -LiteralPath $path)) { return }; try { [IO.Directory]::Delete('\\?\' + $path, $true) } catch { }; if (Test-Path -LiteralPath $path) { cmd.exe /d /c ('rd /s /q "\\?\' + $path + '"') 2>$null | Out-Null } }`;

/**
 * 对端清理命令：结束名字里带这个目录名的进程 → 删目录 → 过一秒再核一遍，两样都没了才报 ROOT_GONE。
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
    // 刚被结束的那条命令可能正走到自己的收尾、又碰了一下目录：隔一秒再看一眼才下结论。
    `Start-Sleep -Milliseconds 1000`,
    `$left = Hits`,
    `if ($script:queryError) { Write-Output ("ROOT_LEFT " + $root + " 进程表查不出来：" + $script:queryError); exit 1 }`,
    `if ((Test-Path -LiteralPath $root) -or $left.Count) { Write-Output ("ROOT_LEFT " + $root + " exists=" + (Test-Path -LiteralPath $root) + " procs=" + (($left | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join ',')); exit 1 }`,
    `Write-Output ("ROOT_GONE " + $root + " existed=" + $existed + " killed=" + $killed)`,
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
  if (!all.length) forget(record.id);
  return { ok: !all.length, detail: remote.detail, problems: all };
}

/** 替属主已经不在的记录结算；返回没结清的条数（账留着，下次再来）。身份不明的记录只报、不动。 */
export async function reclaimPending({ exec, closeSession, log = console.log, attempts, pause }) {
  let failures = 0;
  for (const record of records()) {
    if (record.unknown) {
      failures++;
      log(`✕ 账本记录 ${journalFile(record.id)} 读不出完整身份（${record.unknown}），原样留着、不去碰对端；确认无用后手动删掉它`);
      continue;
    }
    if (record.owner === process.pid || processAlive(record.owner)) continue;
    const result = await settle(record, { exec, closeSession, attempts, pause });
    if (result.ok) {
      log(`✓ 结清上一次留下的对端会话与目录：${result.detail}`);
    } else {
      failures++;
      log(`✕ 上一次留下的 ${remoteRootName(record.id)} 没结清（${result.problems.join("；")}），账留在 ${journalFile(record.id)}`);
    }
  }
  return failures;
}
