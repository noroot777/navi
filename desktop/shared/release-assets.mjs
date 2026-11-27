// 一个版本一个 Release（tag v<版本>）：里面必须有的三个包。合并发布（release-together.mjs）按它判齐了没有；
// putOnRelease 按它认出「这是共用的 Release」，单平台入口（single）不碰。
import { distributionName } from "../macos/scripts/architecture.mjs";
import { installerName } from "../windows/scripts/release-state.mjs";

export const releaseTag = (version) => `v${version}`;
export const releaseAssets = (version) => [distributionName(version, "arm64"), distributionName(version, "x64"), installerName(version)];

/** 这个 tag 公开之前必须在上面的包：v<版本> 是那三个；老的单平台 tag（navi-mac-v… 等）只有它自己那一个。 */
export function requiredAssets(tag, file) {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  const all = version ? releaseAssets(version) : null;
  return all?.includes(file) ? all : [file];
}
