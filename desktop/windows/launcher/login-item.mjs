// 「登录时启动 Navi 服务」（对应 mac 的 LoginService.swift）：登录时跑一次 `Navi.exe --start-server`，起法与打开
// 窗口时完全同一条路径，只是不开窗口。数据根还空着时它不起（首启要先问用户）。
//
// 用 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，不用计划任务：
//   · 不要管理员。schtasks 建「登录时」触发的任务要提权，per-user 安装包要的就是不提权。
//   · 不进 Job。计划任务的进程跑在任务计划程序的 Job 里，任务被结束（手动「结束」、到了默认 72 小时的执行时限）
//     时整个 Job 一起收掉；Run 项由 explorer 拉起，起出来的服务没有这层牵连。
//   · 用户看得见、关得掉：任务管理器「启动应用」页列的就是它，在那里停掉记在 StartupApproved\Run 里，
//     这里读到就按「没开」显示，不替用户再打开。
// 只在登录那一刻跑一次，不守护：用户手动停掉服务（比如要让开发实例临时占用端口）时不会被立刻拉回来。
// Run 项只在 Windows 上有，路径一律按 Windows 的规矩比（mac 上跑回归时也是）。
import { win32 } from "node:path";
import { readSettings, writeSettings } from "./settings.mjs";
import { readRunEntry, writeRunEntry } from "./win-ps.mjs";

export const RUN_VALUE = "Navi";

export const runCommand = (exe) => `"${exe}" --start-server`;

/** Run 里那一行是不是指着这个 exe（引号、大小写、斜杠方向都不计较）。 */
export function pointsAt(command, exe) {
  const match = /^\s*"([^"]+)"|^\s*(\S+)/.exec(command ?? "");
  const registered = match?.[1] ?? match?.[2];
  const norm = (path) => win32.resolve(path).toLowerCase();
  return Boolean(registered) && norm(registered) === norm(exe);
}

/** 装在安装包的默认位置（%LOCALAPPDATA%\Programs\Navi\）：登录项只指向这种位置，不指向随时会删的解压目录。 */
export function isInstalledLocation(cfg, exe) {
  if (!exe) return false;
  const programs = win32.join(win32.dirname(win32.resolve(cfg.home)), "Programs").toLowerCase();
  return win32.resolve(exe).toLowerCase().startsWith(`${programs}\\`);
}

export function createLoginItem(cfg, { read = () => readRunEntry(RUN_VALUE), write = (command) => writeRunEntry(RUN_VALUE, command) } = {}) {
  const exe = cfg.shellExe;
  const state = () => {
    const entry = read();
    // StartupApproved 的第一个字节：偶数 = 允许，奇数 = 在任务管理器里被停用了。
    const disabled = entry.approvedFlag !== null && (entry.approvedFlag & 1) === 1;
    return { entry, disabled, enabled: Boolean(entry.command) && pointsAt(entry.command, exe) && !disabled };
  };
  return {
    isEnabled: () => Boolean(exe) && state().enabled,
    setEnabled(enabled) {
      if (!exe) throw new Error("不知道壳的可执行文件在哪，没法登记登录项。");
      write(enabled ? runCommand(exe) : null);
      writeSettings(cfg, { loginConfigured: true });
      if (state().enabled !== enabled) throw new Error(enabled ? "登录项没写进去（注册表写入后读回来不对）。" : "登录项没删掉。");
    },
    /** 壳启动时调：装好后第一次打开默认开上；之后尊重菜单里的开关。开着、但 exe 换了位置时重写一份。 */
    reconcileAtLaunch() {
      if (!isInstalledLocation(cfg, exe)) return "skipped";
      if (!readSettings(cfg).loginConfigured) { this.setEnabled(true); return "enabled"; }
      // 在任务管理器里停用过的不动：重写会把那个「已停用」一起清掉。
      const { entry, disabled } = state();
      if (entry.command && !disabled && !pointsAt(entry.command, exe)) { this.setEnabled(true); return "moved"; }
      return "kept";
    },
  };
}
