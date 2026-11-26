// 把安装包放上 GitHub Release、确认公开地址下得下来 —— mac（dmg）和 Windows（安装包 exe）发版共用的那一段。
// 更新源（appcast / latest.json）怎么写各家自己管；这里只保证「更新源指向它之前，包已经公开、内容就是本地这份」。
// 出错一律抛 ReleaseStop：调用方按它只打一行说明（不是意外，不带调用栈）。`feed` 是说给人听的更新源名字。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export class ReleaseStop extends Error {}
const die = (line) => { throw new ReleaseStop(line); };
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * 把包放到装包仓库的 Release 上，公开它，给出公开的下载地址。草稿阶段外面什么都看不见：建草稿、传包、
 * 经 API 下回来核对，任何一步失败都不留公开的东西。公开之后（包括公开请求发出去、却没收到答复）出的错
 * 都只能重跑往前补：重跑会认出已公开的 Release、沿用上面的附件。
 */
export async function putOnRelease(github, config, { tag, commit, file, length, name, body, feed = "appcast", say = () => {} }) {
  const repo = config.releaseRepo;
  const target = await tagTarget(github, repo, commit, tag);
  let release = await github.findRelease(repo, tag);
  if (!release) {
    say(`▶ 在 ${repo} 建草稿 Release ${tag}（tag 公开时打在构建提交 ${commit}）`);
    release = await github.createDraftRelease(repo, { tag, target, name, body });
  } else {
    say(`▶ 沿用 ${repo} 里已有的${release.draft ? "草稿 " : " "}Release ${tag}`);
  }
  say(`▶ 传 ${basename(file)}（${(length / 1048576).toFixed(1)} MB）`);
  const asset = await github.uploadAsset(release, file);
  if (release.draft) {
    const back = await github.downloadAsset(asset);
    const got = sha256(back);
    if (back.length !== length || got !== sha256(readFileSync(file))) die(`草稿里的 ${asset.name} 和本地这份不一样（${back.length} 字节，sha256 ${got}）：没有公开。`);
    say(`▶ 公开 Release ${tag}`);
    try {
      release = await github.publishRelease(repo, release, target);
    } catch (error) {
      die(`公开 Release ${tag} 时出错（${error.message}）：它可能已经公开了。${feed} 没有推；直接重跑，会认出它接着补。`);
    }
  }
  const tagged = await github.tagCommit(repo, tag);
  if (tagged !== target) {
    die(`Release ${tag} 已经公开，但它的 tag 指着 ${tagged ?? "（没有）"}，不是构建提交 ${target}：${feed} 没有推。`
      + "请核查 Release 与源码提交，改用新版本发布，不要覆盖或删除已公开的历史包。");
  }
  const published = (release.assets || []).find((a) => a.name === asset.name);
  if (!published) die(`公开后的 Release ${tag} 里找不到 ${asset.name}：${feed} 没有推，重跑会接着补。`);
  return { url: published.browser_download_url };
}

/**
 * Release 的 tag 打在构建这份包的那个提交上（完整 sha）。装包仓库里还没有这个提交、或者同名 tag 已经
 * 指着别的提交，都停在这里 —— 此时什么都还没传。
 */
export async function tagTarget(github, repo, commit, tag) {
  const sha = await github.commitSha(repo, commit);
  if (!sha) die(`${repo} 里还没有提交 ${commit}（这份 app 就是从它构建的）：先 git push，再重跑（什么都还没传）。`);
  const tagged = await github.tagCommit(repo, tag);
  if (tagged && tagged !== sha) {
    die(`${repo} 里已经有 tag ${tag}，指着 ${tagged.slice(0, 12)}，不是这份 app 的构建提交 ${sha.slice(0, 12)}：`
      + "GitHub 会沿用已有的 tag，Release 就对不上源码。请提高版本号重新构建，不要改动已发布的 tag（什么都还没传）。");
  }
  return sha;
}

/** 传上去的包确实下得下来、大小和内容都对（更新源指向它之前最后一道确认）。 */
export async function confirmDownloadable(url, file, length, { feed = "appcast", fetchImpl = fetch, wait = 3000 } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (response.ok) {
      const body = Buffer.from(await response.arrayBuffer());
      const got = sha256(body);
      if (body.length === length && got === sha256(readFileSync(file))) return;
      die(`从 ${url} 下回来的包和本地这份不一样（${body.length} 字节，sha256 ${got}）`);
    }
    await new Promise((done) => setTimeout(done, wait));
  }
  die(`${url} 一直下不下来：没有推 ${feed}。等 GitHub 那边好了重跑一次（会沿用同一个包）。`);
}
