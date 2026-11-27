// `npm run release` 里 Windows 这一边（流程在 desktop/shared/cloud-release.mjs，入口 desktop/release.mjs）：
// 版本号在 shell/tauri.conf.json 顶层的 version；更新清单只有一份 latest.json，倒退、同一版换提交都拒。
import { compareVersions } from "../../shared/release-version.mjs";
import { assertNewer, parseFeed, readConfig, sourceVersion, withVersion } from "./release-state.mjs";

export const platform = {
  label: "win",
  name: "Windows",
  configFile: "desktop/windows/release.json",
  versionFile: "desktop/windows/shell/tauri.conf.json",
  readConfig,
  readVersion: sourceVersion,
  writeVersion: withVersion,
  checkConfig(config) {
    if (!config.publicKey) throw new Error("release.json 里还没有 publicKey（README「发版」）。");
  },
  async preflight({ github, config, version }) {
    const latest = parseFeed((await github.readFile(config.feedRepo, config.feedPath, config.feedBranch))?.text);
    if (latest && compareVersions(version, latest.version) < 0) throw new Error(`Windows 更新清单已经是 ${latest.version}，不能发布更旧的 ${version}`);
    return latest;
  },
  checkHead(latest, version, head) {
    try { assertNewer(version, latest, head); }
    catch (error) { throw new Error(`${error.message}没有修改版本或推送。`); }
  },
  published: (latest, version) => latest?.version === version,
};
