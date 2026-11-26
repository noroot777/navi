// 壳自己的几项设置（mac 放在 UserDefaults 里）：%LOCALAPPDATA%\Navi\settings.json。
//   allowOtherDevices   菜单里的「允许其他设备访问」，服务按起的那一下的值定
//   loginConfigured     「登录时启动 Navi 服务」用户表过态没有（装好后第一次打开默认勾上，之后尊重用户）
// 写入走临时文件加改名，半截的文件不会被读成别的设置。读不出来按缺省值（都是 false）。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readSettings(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(cfg.settingsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

export function writeSettings(cfg, patch) {
  const next = { ...readSettings(cfg), ...patch };
  mkdirSync(dirname(cfg.settingsFile), { recursive: true });
  const stage = `${cfg.settingsFile}.${process.pid}.partial`;
  writeFileSync(stage, JSON.stringify(next, null, 2));
  renameSync(stage, cfg.settingsFile);
  return next;
}

export const allowsOtherDevices = (cfg) => readSettings(cfg).allowOtherDevices === true;
