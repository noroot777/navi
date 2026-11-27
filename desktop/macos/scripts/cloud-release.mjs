// `npm run release:mac -- 0.3.2`：从干净的本地 main 改版本号、提交、推送，再触发云端发布（.github/workflows/release-mac.yml）。
// 流程在 desktop/shared/cloud-release.mjs（和 Windows 共用；`npm run release` 两个平台一起发），这里只有 mac 的差异：
// 版本号在 build.sh 的 VERSION 那一行；更新源按架构各一份 appcast，倒退、同一版换提交、只发了一部分架构都拒。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, releasePlatforms } from "../../shared/cloud-release.mjs";
import { compareVersions } from "./appcast.mjs";
import { architectureConfig, configuredArchitectures } from "./architecture.mjs";
import { WORKFLOW, downloadPage, itemDetails, latestItem, readConfig, runName, sourceVersion } from "./release-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const platform = {
  label: "mac",
  name: "Mac",
  configFile: "desktop/macos/release.json",
  versionFile: "desktop/macos/build.sh",
  workflow: WORKFLOW,
  runName,
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
      throw new Error(`更新源已经是 ${item.shortVersion}，不能发布更旧的 ${version}`);
    }
    return latest;
  },
  checkHead(latest, version, head) {
    for (const item of latest) if (item?.shortVersion === version && item.commit && !head.startsWith(item.commit)) {
      throw new Error(`${version} 已从另一个提交发布；改用新的版本号。没有修改版本或推送。`);
    }
  },
  published(latest, version, config) {
    if (latest.every((item) => item?.shortVersion === version)) return `这一版已在更新源中：${downloadPage(config)}`;
    if (latest.some((item) => item?.shortVersion === version)) {
      throw new Error("只有部分架构已经发布这一版本，且没有可恢复的原工作流：使用新的版本号发布双架构，不重封已公开的包。");
    }
    return null;
  },
  rerunNote: "沿用已保存的构建产物",
  notes: (config) => [`Mac 下载页：${downloadPage(config)}`],
};

export async function releaseCloud(version, { cwd = ROOT, ...options } = {}) {
  return (await releasePlatforms([platform], version, { cwd, ...options }))[0];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli("用法：npm run release:mac -- 0.3.2（两个平台一起发：npm run release -- 0.3.2；本机发布与密钥管理改用 release:mac:local）\n从干净的 main 自动提交版本、push，并触发云端发布。\n本机备用：npm run release:mac:local（选项见 desktop/macos/README.md）", releaseCloud);
}
