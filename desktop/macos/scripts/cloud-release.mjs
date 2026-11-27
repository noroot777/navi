// `npm run release` 里 mac 这一边（流程在 desktop/shared/cloud-release.mjs，入口 desktop/release.mjs）：
// 版本号在 build.sh 的 VERSION 那一行；更新源按架构各一份 appcast，倒退、同一版换提交、只发了一部分架构都拒。
import { compareVersions } from "./appcast.mjs";
import { architectureConfig, configuredArchitectures } from "./architecture.mjs";
import { itemDetails, latestItem, readConfig, sourceVersion } from "./release-state.mjs";

export const platform = {
  label: "mac",
  name: "Mac",
  configFile: "desktop/macos/release.json",
  versionFile: "desktop/macos/build.sh",
  readConfig,
  readVersion: sourceVersion,
  writeVersion: (text, version) => text.replace(/^VERSION="[^"]+"$/m, `VERSION="${version}"`),
  async preflight({ github, config, version }) {
    const latest = await Promise.all(configuredArchitectures(config).map(async (architecture) => {
      const channel = architectureConfig(config, architecture);
      const feed = await github.readFile(channel.feedRepo, channel.appcastPath, channel.feedBranch);
      return itemDetails(latestItem(feed?.text));
    }));
    for (const item of latest) if (item?.shortVersion && compareVersions(version, item.shortVersion) < 0) {
      throw new Error(`Mac 更新源已经是 ${item.shortVersion}，不能发布更旧的 ${version}`);
    }
    return latest;
  },
  checkHead(latest, version, head) {
    for (const item of latest) if (item?.shortVersion === version && item.commit && !head.startsWith(item.commit)) {
      throw new Error(`${version} 已从另一个提交发布；改用新的版本号。没有修改版本或推送。`);
    }
  },
  published(latest, version) {
    if (latest.every((item) => item?.shortVersion === version)) return true;
    if (latest.some((item) => item?.shortVersion === version)) {
      throw new Error(`Mac 只有部分架构已经发布 ${version}，且没有可恢复的原工作流：改用新的版本号，不重封已公开的包。没有修改版本或推送。`);
    }
    return false;
  },
};
