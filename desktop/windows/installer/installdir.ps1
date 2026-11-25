# 安装包和卸载器动手之前跑的两件事（hooks.nsh 调，Windows PowerShell 5.1）。输出只有进程号和映像名（ASCII），
# 中文说明在安装包自己的文案里 —— nsExec 按控制台代码页读输出，这里写中文到那边就是乱码。
#
#   -Mode Release    -InstallDir <安装目录> -NaviHome <%LOCALAPPDATA%\Navi>
#                                              等用着安装目录里文件的进程退干净。壳拉起的控制器（controller-main.mjs）
#                                              和壳自己（Navi.exe）是安装包该收的：壳一关控制器就退，等它 15 秒，
#                                              还在就结束掉（先收壳、再收控制器）。只有一种控制器不收：NaviHome 里
#                                              handover-active.json 记着的那一个 —— 它正在做完一趟换服务、把新版服务
#                                              起起来（launcher/handover-duty.mjs），杀了它服务就没人起了。等它做完
#                                              （最多 4 分钟），还没完就什么都不动、退出码 6。
#                                              别的程序（不认识的）一个都不碰：列出来、退出码 2。
#   -Mode RemoveData -NaviHome <%LOCALAPPDATA%\Navi>   卸载时删数据。有进程跑在那块地里（服务、agent 用的 node 都
#                                              在 runtimes 下）就不删，列出来、退出码 3；整块改名成功（没有文件被
#                                              打开）才删，删不干净的留在改过名的那份里、退出码 4。
param(
  [Parameter(Mandatory = $true)][ValidateSet('Release', 'RemoveData')][string]$Mode,
  [string]$InstallDir,
  [string]$NaviHome,
  # 两个等待时限（秒）。安装包不传、用默认；只给冒烟缩短等待用。
  [int]$ReleaseSeconds = 15,
  [int]$HandoverSeconds = 240
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

# 立着「正在交接」牌子的那个控制器的进程号；没有牌子、读不懂都是 $null。
function Get-HandoverPid {
  if (-not $NaviHome) { return $null }
  try { return [int]((Get-Content -LiteralPath (Join-Path $NaviHome 'handover-active.json') -Raw -ErrorAction Stop | ConvertFrom-Json).pid) }
  catch { return $null }
}

function Write-Users($Processes) {
  $Processes | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }
}

try {
  if ($Mode -eq 'Release') {
    $deadline = (Get-Date).AddSeconds($ReleaseSeconds)
    $handoverDeadline = (Get-Date).AddSeconds($HandoverSeconds)
    $shellsStopped = $false
    while ($true) {
      $users = Get-Users $InstallDir
      if ($users.Count -eq 0) { exit 0 }
      $ours = @($users | Where-Object { Test-Ours $_ })
      if ($ours.Count -eq 0) { break }
      $handing = Get-HandoverPid
      $busy = $handing -and @($ours | Where-Object { [int]$_.ProcessId -eq $handing }).Count -gt 0
      if ($busy) {
        # 在做完交接的那个控制器：等，不杀；过了时限就整个不动手。
        if ((Get-Date) -ge $handoverDeadline) { 'handover'; exit 6 }
      } elseif ((Get-Date) -ge $deadline) {
        # 先收壳：壳一没，它的控制器才开始收尾（可能就此立起牌子），回头再看一遍再收控制器。
        $shells = @($ours | Where-Object { $_.Name -ieq 'Navi.exe' })
        if ($shells.Count -gt 0 -and -not $shellsStopped) {
          foreach ($process in $shells) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
          $shellsStopped = $true
          Start-Sleep -Milliseconds 1000
          continue
        }
        break
      }
      Start-Sleep -Milliseconds 300
    }
    foreach ($process in @($users | Where-Object { Test-Ours $_ })) {
      if ([int]$process.ProcessId -eq (Get-HandoverPid)) { continue }
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $users = Get-Users $InstallDir
    if ($users.Count -eq 0) { exit 0 }
    if (@($users | Where-Object { [int]$_.ProcessId -eq (Get-HandoverPid) }).Count -gt 0) { 'handover'; exit 6 }
    Write-Users $users
    exit 2
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
