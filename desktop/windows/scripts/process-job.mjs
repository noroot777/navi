// 「这次冒烟起过的进程一个都不剩」在 Windows 上的依据：一个 Job Object。
//
// 按父进程号追树是不成立的：Windows 的父子关系只是个 PID 字段，中间那层一退出链就断了，taskkill /T
// 找不到脱链的后代；父进程已经死了时更是无从追起（ConPTY 里的 shell、探针被超时杀掉后留下的孙子都是这样）。
// Job 是 Windows 上唯一「进程进来之后，它此后所有后代自动继承、脱链也跑不掉」的容器
// （scripts/win-remote/kill-tree.mjs 顶部有实测经过）。
//
// 做法：冒烟脚本在起任何子进程之前，先让一个 PowerShell 助手建容器（KILL_ON_JOB_CLOSE）并把**冒烟脚本
// 自己**收进去 —— 之后起的探针、server、ConPTY、shell 生来就在里面，没有「起了再收」的漏网窗口。助手是在
// 收容之前起的，所以它自己不在容器里，句柄只有它拿着：
//   · reap()：把容器里除冒烟脚本以外的成员逐个结束，直到内核报的成员只剩它自己，报不到就如实失败；
//   · 冒烟脚本退出或崩了：助手是它的子进程，跟着被带走（或读到 stdin 断开自己退出），句柄一关，容器里剩下的
//     全部由内核结束。反过来，冒烟脚本还活着时**绝不能**让助手退出 —— 它自己也在容器里，会被一起结束，
//     所以收尾只 release()（放开引用，让进程能自然退出），不去关助手。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const JOB_CS = `
using System;
using System.Runtime.InteropServices;
namespace NaviSmoke {
  public static class Job {
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit {
      public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
      public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
      public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit {
      public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create() {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return job;
      ExtendedLimit limit = new ExtendedLimit();
      limit.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      int len = Marshal.SizeOf(typeof(ExtendedLimit));
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        Marshal.StructureToPtr(limit, buf, false);
        if (!SetInformationJobObject(job, 9, buf, (uint)len)) { CloseHandle(job); return IntPtr.Zero; }
      } finally { Marshal.FreeHGlobal(buf); }
      return job;
    }
    public static int Assign(IntPtr job, int pid) {
      IntPtr process = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
      if (process == IntPtr.Zero) return Marshal.GetLastWin32Error();
      try { return AssignProcessToJobObject(job, process) ? 0 : Marshal.GetLastWin32Error(); } finally { CloseHandle(process); }
    }
    // JOBOBJECT_BASIC_PROCESS_ID_LIST：两个 DWORD，后面是 ULONG_PTR 数组（x64 上从偏移 8 开始）。
    public static int[] Members(IntPtr job) {
      const int capacity = 4096;
      int len = 8 + IntPtr.Size * capacity;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (!QueryInformationJobObject(job, 3, buf, (uint)len, IntPtr.Zero)) return null;
        int count = Marshal.ReadInt32(buf, 4);
        int[] ids = new int[count];
        for (int i = 0; i < count; i++) ids[i] = (int)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
        return ids;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    public static void Kill(int pid) {
      IntPtr process = OpenProcess(0x0001, false, pid);
      if (process == IntPtr.Zero) return;
      try { TerminateProcess(process, 1); } finally { CloseHandle(process); }
    }
  }
}`;

const HELPER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$owner = [int]$env:NAVI_JOB_OWNER
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JOB_CS, "utf8").toString("base64")}')))
$job = [NaviSmoke.Job]::Create()
if ($job -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('ERROR 建不出 Job'); exit 1 }
$code = [NaviSmoke.Job]::Assign($job, $owner)
if ($code -ne 0) { [Console]::Out.WriteLine("ERROR 收不进 Job（Win32 错误 $code）"); exit 1 }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -ne 'REAP') { continue }
  $deadline = (Get-Date).AddSeconds(15)
  $others = @()
  do {
    $members = [NaviSmoke.Job]::Members($job)
    if ($null -eq $members) { [Console]::Out.WriteLine('ERROR 问不到 Job 成员'); [Console]::Out.Flush(); $others = $null; break }
    $others = @($members | Where-Object { $_ -ne $owner })
    if ($others.Count -eq 0) { break }
    foreach ($id in $others) { [NaviSmoke.Job]::Kill($id) }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  if ($null -ne $others) { [Console]::Out.WriteLine('REAPED ' + $others.Count + ' ' + ($others -join ',')); [Console]::Out.Flush() }
}
`;

/** 建容器并把当前进程收进去；必须在起任何子进程之前调用。返回 { reap, release }。 */
export async function claimProcessJob() {
  if (process.platform !== "win32") throw new Error("Job Object 只在 Windows 上有");
  const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HELPER, "utf16le").toString("base64")], {
    env: { ...process.env, NAVI_JOB_OWNER: String(process.pid) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  helper.stderr.on("data", (bytes) => { stderr += bytes; });
  const lines = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  const next = async (timeoutMs) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Job 助手 ${timeoutMs / 1000} 秒没回话：${stderr}`)), timeoutMs); });
    try {
      const { value, done } = await Promise.race([lines.next(), late]);
      if (done) throw new Error(`Job 助手退出了：${stderr}`);
      return value.trim();
    } finally { clearTimeout(timer); }
  };
  const ready = await next(30_000);
  if (ready !== "READY") throw new Error(`Job 建不起来：${ready} ${stderr}`);
  return {
    /** 结束容器里除本进程以外的全部成员，并确认内核报的成员只剩本进程。 */
    async reap() {
      helper.stdin.write("REAP\n");
      const reply = await next(30_000);
      const match = /^REAPED (\d+) ?(.*)$/.exec(reply);
      if (!match) throw new Error(`回收 Job 失败：${reply}`);
      if (match[1] !== "0") throw new Error(`Job 里仍有 ${match[1]} 个进程没退出：${match[2]}`);
    },
    /** 不再需要回收时调用：只放开引用，让本进程能自然退出；助手随本进程一起结束（见文件顶部）。 */
    release() {
      for (const stream of [helper.stdin, helper.stdout, helper.stderr]) stream.unref?.();
      helper.unref();
    },
  };
}
