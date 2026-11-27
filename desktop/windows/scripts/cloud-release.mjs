// `npm run release:win -- 0.1.0`：从干净的本地 main 改版本号、提交、推送，再触发云端发布（.github/workflows/release-win.yml）。
// 流程在 desktop/shared/cloud-release.mjs（和 mac 共用；`npm run release` 两个平台一起发），这里只有 Windows 的差异：
// 版本号在 shell/tauri.conf.json 顶层的 version；更新清单只有一份 latest.json，倒退、同一版换提交都拒。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, releasePlatforms } from "../../shared/cloud-release.mjs";
import { compareVersions } from "../../shared/release-version.mjs";
import { WORKFLOW, assertNewer, parseFeed, readConfig, runName, sourceVersion, withVersion } from "./release-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const platform = {
  label: "win",
  name: "Windows",
  configFile: "desktop/windows/release.json",
  versionFile: "desktop/windows/shell/tauri.conf.json",
  workflow: WORKFLOW,
  runName,
  readConfig,
  readVersion: sourceVersion,
  writeVersion: withVersion,
  checkConfig(config) {
    if (!config.publicKey) throw new Error("release.json 里还没有 publicKey（README「发版」）。");
  },
  async preflight({ github, config, version }) {
    const latest = parseFeed((await github.readFile(config.feedRepo, config.feedPath, config.feedBranch))?.text);
    if (latest && compareVersions(version, latest.version) < 0) throw new Error(`更新清单已经是 ${latest.version}，不能发布更旧的 ${version}`);
    return latest;
  },
  checkHead(latest, version, head) {
    try { assertNewer(version, latest, head); }
    catch (error) { throw new Error(`${error.message}没有修改版本或推送。`); }
  },
  published: (latest, version) => (latest?.version === version ? `这一版已在更新清单里：${latest.url}` : null),
  rerunNote: "沿用已保存的安装包",
};

export async function releaseCloud(version, { cwd = ROOT, ...options } = {}) {
  return (await releasePlatforms([platform], version, { cwd, ...options }))[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli("用法：npm run release:win -- 0.1.0（两个平台一起发：npm run release -- 0.1.0）\n从干净的 main 自动提交版本、push，并触发云端发布（.github/workflows/release-win.yml）。", releaseCloud);
}
