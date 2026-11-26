import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CODE_DIR, DATA_DIR } from "./paths.js";

export type RuntimeCompatibility = { protocol: number; schema: string };

/**
 * 桌面版的运行时仓库在哪（发布出来的运行时都在它下面，目录名就是内容清单的 id）：
 *   mac      <数据根>/.mac-runtimes（desktop/macos/README.md「装之前那道闸」）
 *   Windows  %LOCALAPPDATA%\Navi\runtimes（desktop/windows/scripts/layout.mjs）—— 不在数据根下：服务的文件被占用时
 *            删不掉也改不了名，运行时跟着安装位置那一侧走，数据根只放数据
 * 别的系统没有桌面版，是 null。
 */
export function managedRuntimeStore(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  dataDir: string = DATA_DIR): string | null {
  if (platform === "darwin") return join(dataDir, ".mac-runtimes");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return local && isAbsolute(local) ? join(local, "Navi", "runtimes") : null;
  }
  return null;
}

export function runtimeCompatibility(): RuntimeCompatibility {
  return runtimeCompatibilityAt(CODE_DIR, managedRuntimeStore());
}

/**
 * 跑着的这份代码是不是仓库里一份完整的受管运行时，是就读出它的接管协议。清单格式按系统分
 * （desktop/shared/runtime-store.mjs）：format 1（mac）每条文件记 [路径, "file", 可执行位, sha256]，
 * format 2（Windows）记 [路径, "file", sha256]，Windows 上路径不分大小写。
 */
export function runtimeCompatibilityAt(codeDir: string, store: string | null, platform: NodeJS.Platform = process.platform): RuntimeCompatibility {
  const windows = platform === "win32";
  const real = (path: string) => (windows ? realpathSync.native(path).toLowerCase() : realpathSync(path));
  if (!store) throw new Error("服务不是本数据根的受管运行时");
  const root = windows ? realpathSync.native(codeDir) : realpathSync(codeDir);
  let storeRoot: string;
  try { storeRoot = real(store); } catch { throw new Error("服务不是本数据根的受管运行时"); }
  if (real(dirname(root)) !== storeRoot) throw new Error("服务不是本数据根的受管运行时");
  const manifest = JSON.parse(readFileSync(join(root, ".runtime.json"), "utf8"));
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const format = windows ? 2 : 1;
  if (manifest.format !== format || (windows && manifest.platform !== "win32")) throw new Error("运行时版本身份不符");
  const id = windows ? basename(root).toLowerCase() : basename(root);
  if (manifest.id !== id || manifest.id !== digest(JSON.stringify(manifest.entries))) throw new Error("运行时版本身份不符");
  const text = readFileSync(join(root, ".handover.json"), "utf8");
  const sealed = (entry: unknown[]) => entry[0] === ".handover.json" && entry[1] === "file" && entry[format === 1 ? 3 : 2] === digest(text);
  if (!manifest.entries.some(sealed)) throw new Error("运行时协议身份不符");
  const compatibility = JSON.parse(text);
  if (compatibility.protocol !== 1 || !/^[a-f0-9]{64}$/.test(compatibility.schema)) throw new Error("运行时协议不兼容");
  return compatibility;
}

export function assertRuntimeCompatibility(current: RuntimeCompatibility, next: Partial<RuntimeCompatibility>, active: boolean): void {
  if (next.protocol !== 1 || current.protocol !== next.protocol || !/^[a-f0-9]{64}$/.test(next.schema ?? "")) throw new Error("接管协议不兼容");
  if (active && current.schema !== next.schema) throw new Error("迁移兼容性不明，等待任务结束后再迁移");
}
