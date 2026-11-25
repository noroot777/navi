// 控制器问 Windows 的几件事（注册表、端口上的进程）都经 PowerShell 问：reg.exe / netstat 的输出走控制台代码页
// （测试机是 GBK），路径里一有中文就乱。这里脚本用 -EncodedCommand（UTF-16）送进去，结果在对端先转成
// UTF-8 的 JSON 再 base64 出来，两头都不经过代码页。
//
// 每个函数都收一个可注入的 `ps`，回归在 mac 上换成假的，按脚本里的标记回答。
import { spawnSync } from "node:child_process";

export function runPowerShell(script, { timeoutMs = 20_000 } = {}) {
  // 进度条关掉：第一次加载模块时它往 stderr 写一大段 CLIXML，还拖慢启动。
  const wrapped = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$result = & { ${script} }
$json = ConvertTo-Json -InputObject $result -Compress -Depth 6
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$json)))`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  const run = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", windowsHide: true, timeout: timeoutMs,
  });
  if (run.error || run.status !== 0) {
    throw new Error(`PowerShell 失败：${run.error?.message ?? `退出码 ${run.status}`} ${(run.stderr ?? "").slice(0, 400)}`.trim());
  }
  const text = Buffer.from(run.stdout.trim(), "base64").toString("utf8");
  return text ? JSON.parse(text) : null;
}

// 单引号字符串：PowerShell 里单引号里只有 '' 一种转义。
export const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/**
 * 注册表里此刻的 PATH（系统那份在前、用户那份在后，REG_EXPAND_SZ 按当前环境展开），同 explorer 登录时拼的顺序。
 * 用户装完 claude / codex 后，安装器改的是注册表，explorer 早先传下来的那份 PATH 还是旧的。
 */
export function registryPath(ps = runPowerShell) {
  const parts = ps(`
$machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
$user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
@{ machine = if ($machine) { [string]$machine.GetValue('Path', '') } else { '' };
   user = if ($user) { [string]$user.GetValue('Path', '') } else { '' } }`);
  return [parts?.machine, parts?.user].filter((part) => typeof part === "string" && part).join(";");
}

/** 登录时启动那一项此刻的样子：Run 里写的命令、任务管理器「启动」页有没有把它停掉。 */
export function readRunEntry(name, ps = runPowerShell) {
  const entry = ps(`
function Value($key) { $item = Get-ItemProperty -LiteralPath $key -Name ${psq(name)} -ErrorAction SilentlyContinue; if ($item) { $item.PSObject.Properties[${psq(name)}].Value } }
$command = Value ${psq(RUN_KEY)}
$approved = Value ${psq(APPROVED_KEY)}
@{ command = if ($command) { [string]$command } else { $null };
   approved = if ($approved) { [int]$approved[0] } else { $null } }`);
  return { command: entry?.command ?? null, approvedFlag: Number.isInteger(entry?.approved) ? entry.approved : null };
}

/** 写上（同时清掉任务管理器留下的「已禁用」，不然写了也不生效）或删掉。 */
export function writeRunEntry(name, command, ps = runPowerShell) {
  ps(command === null
    ? `Remove-ItemProperty -LiteralPath ${psq(RUN_KEY)} -Name ${psq(name)} -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath ${psq(APPROVED_KEY)} -Name ${psq(name)} -ErrorAction SilentlyContinue
$true`
    : `if (-not (Test-Path -LiteralPath ${psq(RUN_KEY)})) { New-Item -Path ${psq(RUN_KEY)} -Force | Out-Null }
Set-ItemProperty -LiteralPath ${psq(RUN_KEY)} -Name ${psq(name)} -Value ${psq(command)} -Type String
Remove-ItemProperty -LiteralPath ${psq(APPROVED_KEY)} -Name ${psq(name)} -ErrorAction SilentlyContinue
$true`);
}

/** 谁在监听这个端口：进程号、映像名、可执行文件路径（查不到的字段是 null）。 */
export function portListeners(port, ps = runPowerShell) {
  const rows = ps(`
$ids = @(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
@($ids | ForEach-Object {
  $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
  @{ pid = [int]$_; name = if ($p) { $p.ProcessName } else { $null }; path = if ($p) { $p.Path } else { $null } }
})`);
  return (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((row) => Number.isInteger(row?.pid) && row.pid > 0);
}
