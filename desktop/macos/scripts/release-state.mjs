import { readFileSync } from "node:fs";
import { WORKFLOW, assertVersion, runName } from "../../shared/release-version.mjs";
import { compareVersions, latestVersion, parseItems } from "./appcast.mjs";

export const DOWNLOAD_TAG = "navi-mac-latest";
export const LINK_COMMIT_PREFIX = "docs(README): mac 版下载指向";

export { WORKFLOW, assertVersion, runName };

export function readConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (config.repo) throw new Error(`${path} 还是只有一个 repo 的旧格式：拆成 releaseRepo 和 feedRepo。`);
  for (const field of ["releaseRepo", "feedRepo"]) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config[field] ?? "")) throw new Error(`${path} 里缺少有效的 ${field}`);
  }
  return { feedBranch: "main", appcastPath: "appcast.xml", tagPrefix: "v", downloadTag: DOWNLOAD_TAG, ...config };
}

export function sourceVersion(text) {
  const lines = [...text.matchAll(/^VERSION="([^"]+)"$/gm)];
  if (lines.length !== 1) throw new Error("build.sh 里没有唯一的 VERSION=\"…\" 行");
  return assertVersion(lines[0][1]);
}

export function latestItem(text) {
  const items = parseItems(text);
  return items.find((item) => item.version === latestVersion(items)) ?? null;
}

export function itemDetails(item) {
  if (!item) return null;
  return {
    version: item.version,
    shortVersion: item.xml.match(/<sparkle:shortVersionString>\s*([^<]+?)\s*<\/sparkle:shortVersionString>/)?.[1],
    commit: item.xml.match(/<(navi|ash):commit>\s*([0-9a-f]{7,40})\s*<\/\1:commit>/)?.[2],
    url: item.xml.match(/<enclosure\b[^>]*\burl="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&"),
  };
}

export function nextBuildNumber(latest, clock = new Date()) {
  if (!Number.isFinite(clock.getTime())) throw new Error("构建时间无效");
  const stamp = clock.toISOString().replace(/[-:TZ]/g, "").replace(/^(\d{8})(\d{6})\.\d+$/, "$1.$2");
  if (!latest || compareVersions(stamp, latest) > 0) return stamp;
  if (!/^\d{8}\.\d+$/.test(latest)) throw new Error(`更新源的构建号无效：${latest}`);
  const [date, serial] = latest.split(".");
  return `${date}.${String(Number(serial) + 1).padStart(6, "0")}`;
}

export const downloadPage = (config) => `https://github.com/${config.releaseRepo}/releases/tag/${config.downloadTag}`;
