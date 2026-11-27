// `npm run release -- 0.3.6`：mac（Apple 芯片、Intel）和 Windows 一起发同一个版本号，同一个 Release（tag v0.3.6）里放三个安装包。
// 两边的版本号进同一个提交、推一次，再触发云端工作流 release.yml（流程见 desktop/shared/cloud-release.mjs）。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as mac } from "./macos/scripts/cloud-release.mjs";
import { releaseCloud } from "./shared/cloud-release.mjs";
import { platform as win } from "./windows/scripts/cloud-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "用法：npm run release -- 0.3.6";

export const releaseAll = (version, { cwd = ROOT, ...options } = {}) => releaseCloud([mac, win], version, { cwd, ...options });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--help") {
    console.log(`${USAGE}\nmac 和 Windows 一起发同一个版本号：从干净的 main 把两边的版本号改进同一个提交、push，再触发云端工作流 release.yml；\n发完是一个 Release，里面三个安装包（Apple 芯片 dmg、Intel dmg、Windows 安装包）。`);
  } else if (process.argv.length !== 3) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    releaseAll(process.argv[2]).catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
  }
}
