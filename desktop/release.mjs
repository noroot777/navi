// `npm run release -- 0.3.5`：mac 和 Windows 一起发同一个版本号。两边的预检都过了才动版本号，
// 两个版本文件进同一个提交、推一次，再用同一个 SHA 各自触发云端工作流（流程见 desktop/shared/cloud-release.mjs）。
// 只发一边用 release:mac / release:win。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as mac } from "./macos/scripts/cloud-release.mjs";
import { cli, releasePlatforms } from "./shared/cloud-release.mjs";
import { platform as win } from "./windows/scripts/cloud-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const releaseAll = (version, { cwd = ROOT, ...options } = {}) => releasePlatforms([mac, win], version, { cwd, ...options });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli("用法：npm run release -- 0.3.5\nmac 和 Windows 一起发同一个版本号：从干净的 main 把两边的版本号改进同一个提交、push，再触发两条云端工作流。\n只发一边：npm run release:mac / npm run release:win", releaseAll);
}
