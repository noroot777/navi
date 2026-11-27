// Windows 发版的状态与配置（对应 mac 的 release-state.mjs）：release.json、源码里的版本号、更新清单 latest.json 的读写。
//
// 更新清单是 Tauri updater 的静态格式：{ version, notes, pub_date, platforms: { "windows-x86_64": { url, signature } } }。
// 壳只看这几项（签名验的是下载下来的安装包本身，清单不签）；另外记一段 navi（源码提交、安装包大小和 sha256），
// 给发版脚本自己核对「这一版是不是从这个提交发的」「公开地址上那份是不是原包」，updater 不认识的字段一律不看。
import { readFileSync } from "node:fs";
import { WORKFLOW, assertVersion, compareVersions, runName } from "../../shared/release-version.mjs";

export { WORKFLOW, runName };

export const PLATFORM = "windows-x86_64";

export function readConfig(path) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  for (const field of ["releaseRepo", "feedRepo"]) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config[field] ?? "")) throw new Error(`${path} 里缺少有效的 ${field}`);
  }
  if (!/^[\w./-]+\.json$/.test(config.feedPath ?? "")) throw new Error(`${path} 里缺少有效的 feedPath`);
  if (!/^[\w.-]+$/.test(config.tagPrefix ?? "")) throw new Error(`${path} 里缺少有效的 tagPrefix`);
  return { feedBranch: "main", ...config };
}

/** 源码里的版本号：shell/tauri.conf.json 的 version（安装包、关于、updater 比较用的都是它）。 */
export function sourceVersion(text) {
  let version;
  try { version = JSON.parse(text).version; } catch { throw new Error("tauri.conf.json 不是合法的 JSON"); }
  return assertVersion(version);
}

/** 把 tauri.conf.json 里的版本号换掉，别的一个字节不动（发版提交只改这一处）。 */
export function withVersion(text, version) {
  assertVersion(version);
  const lines = [...text.matchAll(/^  "version": "[^"]*",$/gm)];
  if (lines.length !== 1) throw new Error("tauri.conf.json 里没有唯一的顶层 \"version\" 行");
  const next = text.replace(/^  "version": "[^"]*",$/m, `  "version": "${version}",`);
  if (sourceVersion(next) !== version) throw new Error("改版本号后读回来不对");
  return next;
}

export const feedURL = (config) => `https://raw.githubusercontent.com/${config.feedRepo}/${encodeURIComponent(config.feedBranch)}/${config.feedPath}`;
export const tagFor = (config, version) => `${config.tagPrefix}${version}`;
export const installerName = (version) => `Navi-${version}-x64-setup.exe`;
export const assetURL = (config, version) => `https://github.com/${config.releaseRepo}/releases/download/${tagFor(config, version)}/${installerName(version)}`;

/** 读更新清单：没有是 null；认不出的（不是这个格式、版本号不合规）直接报错，不拿它当「还没发过」。 */
export function parseFeed(text) {
  if (text === null || text === undefined) return null;
  let feed;
  try { feed = JSON.parse(text); } catch { throw new Error("更新清单不是合法的 JSON"); }
  assertVersion(feed?.version);
  const platform = feed.platforms?.[PLATFORM];
  if (typeof platform?.url !== "string" || typeof platform?.signature !== "string") throw new Error(`更新清单里没有 ${PLATFORM} 的地址和签名`);
  return { version: feed.version, url: platform.url, signature: platform.signature, commit: feed.navi?.commit ?? null,
    sha256: feed.navi?.sha256 ?? null, size: feed.navi?.size ?? null };
}

export function renderFeed({ version, notes, date = new Date(), url, signature, commit, sha256, size }) {
  assertVersion(version);
  return `${JSON.stringify({
    version, notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { [PLATFORM]: { url, signature } },
    navi: { commit, sha256, size },
  }, null, 2)}\n`;
}

/** 这一版能不能接在清单里那一版后面：更旧不行；同一版只能是同一个提交（补收尾），换了提交要换版本号。 */
export function assertNewer(version, latest, commit) {
  if (!latest) return "fresh";
  const order = compareVersions(version, latest.version);
  if (order < 0) throw new Error(`更新清单已经是 ${latest.version}，不能发布更旧的 ${version}`);
  if (order > 0) return "fresh";
  if (latest.commit && commit && !commit.startsWith(latest.commit) && !latest.commit.startsWith(commit)) {
    throw new Error(`${version} 已从另一个提交（${latest.commit}）发布；改用新的版本号。`);
  }
  return "published";
}
