// Windows 版落在本机的位置（per-user，不要管理员）：
//
//   %LOCALAPPDATA%\Navi\runtimes\<sha256>\   发布出来的自带运行时，服务从这里跑（desktop/shared/runtime-store.mjs）
//   %LOCALAPPDATA%\Navi\data\                数据根（NAVI_DATA_DIR）
//   %LOCALAPPDATA%\Navi\data\logs\           日志，跟着数据走
//
// 换安装包时不碰正在跑的服务：Windows 上被占用的文件删不掉也改不了名，所以安装目录里那份只是发布源，
// 服务永远跑在按内容寻址的发布目录里，新版发布到另一个目录。
import { isAbsolute, join } from "node:path";

function localAppData(env) {
  const root = env.LOCALAPPDATA;
  if (!root || !isAbsolute(root)) throw new Error("LOCALAPPDATA 未设置或不是绝对路径");
  return root;
}

const under = (env, ...parts) => join(localAppData(env), "Navi", ...parts);

export const runtimeStore = (env = process.env) => under(env, "runtimes");
export const dataRoot = (env = process.env) => under(env, "data");
export const logsDir = (env = process.env) => under(env, "data", "logs");
