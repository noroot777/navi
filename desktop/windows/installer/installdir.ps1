# 安装包和卸载器动手之前跑的两件事（hooks.nsh 调，Windows PowerShell 5.1）。输出只有进程号和映像名（ASCII），
# 中文说明在安装包自己的文案里 —— nsExec 按控制台代码页读输出，这里写中文到那边就是乱码。
#
#   -Mode Release    -InstallDir <安装目录>   等用着安装目录里文件的进程退干净。壳（Navi.exe）等 15 秒还在就结束掉：
#                                              它不担任何事。壳拉起的控制器（controller-main.mjs）**一律不杀**：壳一没
#                                              它就收尾、做完自己退；它可能正在做一趟撤不回的换服务、要把新版服务起起来
#                                              （launcher/handover.mjs），这边看不出来，也没有哪种「没看到」能证明它没在做。
#                                              等它退（最多 4 分钟），还在就什么都不动：列出来、退出码 6。
#                                              别的程序（不认识的）一个都不碰：列出来、退出码 2。
#   -Mode RemoveData -NaviHome <%LOCALAPPDATA%\Navi>   卸载时删数据。有进程跑在那块地里（服务、agent 用的 node 都
#                                              在 runtimes 下）就不删，列出来、退出码 3；整块改名成功（没有文件被
#                                              打开）才删，删不干净的留在改过名的那份里、退出码 4。
param(
  [Parameter(Mandatory = $true)][ValidateSet('Release', 'RemoveData')][string]$Mode,
  [string]$InstallDir,
  [string]$NaviHome,
  # 两个等待时限（秒）：壳多久不退就结束它、控制器最多等多久。安装包不传、用默认；只给冒烟缩短等待用。
  [int]$ShellSeconds = 15,
  [int]$ControllerSeconds = 240
)
$ErrorActionPreference = 'Stop'

function Test-Under([string]$Path, [string]$Root) {
  if (-not $Path -or -not $Root) { return $false }
  return $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# 进程表查不出来不能当成「没人在用」：抛出去，退出码非 0。
# 调起这个脚本的那一串（自己、安装包或卸载器）不算：卸载器跑在安装目录里（`uninstall.exe _?=<安装目录>`，从「设置」
# 卸载时是复制到临时目录的 Au_.exe，命令行里同样带着安装目录），不排除它就永远认为有人在用。
function Get-Users([string]$Root) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $parent = @{}
  foreach ($process in $all) { $parent[[int]$process.ProcessId] = [int]$process.ParentProcessId }
  $self = @(); $id = [int]$PID
  while ($parent.ContainsKey($id) -and -not ($self -contains $id)) { $self += $id; $id = $parent[$id] }
  @($all | Where-Object {
    -not ($self -contains [int]$_.ProcessId) -and ((Test-Under $_.ExecutablePath $Root) -or ($_.CommandLine -and $_.CommandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0))
  })
}

function Test-Ours($Process) {
  return $Process.Name -ieq 'Navi.exe' -or ($Process.Name -ieq 'node.exe' -and $Process.CommandLine -match 'controller-main\.mjs')
}

function Write-Users($Processes) {
  $Processes | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }
}

try {
  if ($Mode -eq 'Release') {
    $shellDeadline = (Get-Date).AddSeconds($ShellSeconds)
    $deadline = (Get-Date).AddSeconds($ControllerSeconds)
    while ($true) {
      $users = Get-Users $InstallDir
      if ($users.Count -eq 0) { exit 0 }
      $ours = @($users | Where-Object { Test-Ours $_ })
      if ($ours.Count -eq 0) { Write-Users $users; exit 2 }
      if ((Get-Date) -ge $shellDeadline) {
        foreach ($process in @($ours | Where-Object { $_.Name -ieq 'Navi.exe' })) {
          Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
      }
      if ((Get-Date) -ge $deadline) { Write-Users $users; exit 6 }
      Start-Sleep -Milliseconds 300
    }
  }

  if (-not (Test-Path -LiteralPath $NaviHome)) { exit 0 }
  $users = Get-Users $NaviHome
  if ($users.Count -gt 0) { Write-Users $users; exit 3 }
  $leaf = '{0}.removing-{1}' -f (Split-Path -Leaf $NaviHome), $PID
  try { Rename-Item -LiteralPath $NaviHome -NewName $leaf }
  catch { 'locked'; exit 3 }
  $moved = Join-Path (Split-Path -Parent $NaviHome) $leaf
  Remove-Item -LiteralPath $moved -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $moved) { $moved; exit 4 }
  exit 0
} catch {
  'error'
  exit 5
}
