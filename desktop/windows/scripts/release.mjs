#!/usr/bin/env node
// 发一版 Windows 桌面版（对应 mac 的 release.mjs）：给安装包出 updater 签名、自己先验一遍 → 在装包仓库（release.json 的
// releaseRepo）建 Release、传安装包 → 把更新清单 latest.json 经 GitHub API 提交进清单仓库（feedRepo 的 feedPath）。
// 已装的壳每 6 小时拉那份清单，看到更新的版本就问用户装不装；同一个安装包也是新用户下载安装的那个。
//
//   node desktop/windows/scripts/release.mjs --installer <Navi-<v>-x64-setup.exe> --version <v> --commit <完整 sha> --key-file <私钥>
//   node desktop/windows/scripts/release.mjs ... --local <目录> --base-url <http://…/>   # 演练：安装包和清单写进本地目录，不碰 GitHub
//
// 正式发布由云端工作流调（release.yml → desktop/shared/release-together.mjs），私钥只在那一步从 Secret 落成临时文件。
// --stage / --finish 给合并发布用（几个平台的包在同一个 Release 里）：--stage 只把安装包传进草稿并核对，
// 不公开、不推清单；--finish 在 Release 公开之后核对它、再推清单。
// 几条不变量（同 mac，README「发版」）：
//  · 签名验不过 release.json 的公钥（Secret 里的私钥和仓库里的公钥不是一对）就什么都不传：发出去谁都装不上。
//  · 版本只能往前；同一版只能是同一个提交、同一个包（清单里记着 sha256），补收尾不重签不重传。
//  · 两个仓库都要当场证明写得了；包先进草稿、下回核对、公开、确认公开地址下得下来，最后才推清单：清单永远
//    不指向一个还不存在的包。公开不撤回，之后哪一步失败都只靠重跑往前补。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readEnv } from "../../../scripts/env.mjs";
import { GitHub, NO_TOKEN_HINT, resolveToken } from "../../shared/release-github.mjs";
import { ReleaseStop, confirmDownloadable, putOnRelease } from "../../shared/release-publish.mjs";
import { signFile, verifySignature } from "./minisign.mjs";
import { assertNewer, feedURL, installerName, parseFeed, readConfig, renderFeed, tagFor } from "./release-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
// 只给回归测试换一份发版配置（配合 release-github.mjs 的 NAVI_RELEASE_GITHUB_API 演练正式发布）。
const CONFIG_PATH = readEnv(process.env, "NAVI_WIN_RELEASE_CONFIG") || join(HERE, "..", "release.json");
const FEED = "更新清单";

const say = (line) => process.stdout.write(`${line}\n`);
const die = (line) => { throw new ReleaseStop(line); };
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export async function release({ installer, version, commit, keyFile, notes, local, baseURL, github, mode = "single", signer = (file, v, key) => signFile(file, v, readFileSync(key, "utf8")) }) {
  if (mode !== "single" && local) die("--stage / --finish 只用于正式发布，不和 --local 一起用");
  const config = readConfig(CONFIG_PATH);
  installer = resolve(installer);
  if (basename(installer) !== installerName(version)) die(`安装包该叫 ${installerName(version)}，不是 ${basename(installer)}`);
  if (!existsSync(installer)) die(`没有 ${installer}`);
  if (!local && !/^[a-f0-9]{40}$/.test(commit ?? "")) die("正式发布要给构建提交的完整 sha（--commit）");
  if (local && !baseURL) die("演练要给 --base-url（壳从这个地址下安装包）");
  const length = statSync(installer).size;
  const digest = sha256(installer);

  // ── 1. 两个仓库都写得了，读出清单里现在那一版 ──
  let remote = null;
  if (!local) {
    if (!config.publicKey) die("release.json 里还没有 publicKey");
    if (!github) {
      const auth = resolveToken();
      if (!auth) die(NO_TOKEN_HINT);
      github = new GitHub(auth.token);
    }
    const repos = [...new Set([config.releaseRepo, config.feedRepo])];
    const readOnly = [];
    for (const repo of repos) if (!(await github.canWrite(repo))) readOnly.push(repo);
    if (readOnly.length) die(`这张凭证对 ${readOnly.join("、")} 没有写权限：安装包要传到 ${config.releaseRepo}、清单要提交进 ${config.feedRepo}，缺一样就一样都不传。`);
    const blocked = await github.branchRestrictions(config.feedRepo, config.feedBranch);
    if (blocked.length) die(`${config.feedRepo} 的 ${config.feedBranch} 分支上${blocked.join("、")}：清单是直接提交到这个分支的，证明不了提得上去，就一样都不传。`);
    remote = await github.readFile(config.feedRepo, config.feedPath, config.feedBranch);
  }
  const feedFile = local ? join(local, "latest.json") : null;
  const current = local ? (existsSync(feedFile) ? readFileSync(feedFile, "utf8") : null) : remote?.text ?? null;
  const latest = parseFeed(current);
  const state = assertNewer(version, latest, commit);
  if (state === "published") {
    if (latest.sha256 && latest.sha256 !== digest) die(`${version} 已经发过了，而且不是这个包（清单里 sha256 ${latest.sha256}）：改用新的版本号。`);
    say(`✓ ${version} 已经在${FEED}里了：${latest.url}（没有重新发）`);
    return { url: latest.url, already: true };
  }

  // ── 2. 签名，并用 release.json 的公钥验一遍 ──
  const signature = signer(installer, version, keyFile);
  const publicKey = local ? readEnv(process.env, "NAVI_WIN_UPDATER_PUBLIC_KEY") || config.publicKey : config.publicKey;
  try { verifySignature(readFileSync(installer), signature, publicKey, { version }); }
  catch (error) { die(`签名没验过（${error.message}）：私钥和${local ? "这次演练" : " release.json "}的公钥不是一对，发出去谁都装不上，什么都没传。`); }
  say(`▶ 签名已用公钥验过（绑定版本 ${version}）`);
  const text = (notes ?? releaseNotes(latest?.commit, commit)).trim();

  // ── 3. 先把包放上去，确认下得下来 ──
  let url;
  if (local) {
    mkdirSync(local, { recursive: true });
    copyFileSync(installer, join(local, basename(installer)));
    url = new URL(basename(installer), baseURL.endsWith("/") ? baseURL : `${baseURL}/`).href;
  } else {
    const tag = tagFor(config, version);
    ({ url } = await putOnRelease(github, config, {
      tag, commit, file: installer, length, feed: FEED, say, mode,
      name: `Navi for Windows ${version}`,
      body: `${text}\n\n安装：下载 ${basename(installer)} 双击运行（装在自己的用户目录下，不要管理员）。`
        + "Windows 会提示「未知发布者」：点「更多信息」→「仍要运行」。已经装了的会自己提示更新。",
    }));
    if (mode === "stage") {
      say(`✓ ${basename(installer)} 已在 Release ${tag} 的草稿里`);
      return { staged: true, signature };
    }
    await confirmDownloadable(url, installer, length, { feed: FEED });
  }

  // ── 4. 最后推清单 ──
  const feed = renderFeed({ version, notes: text, url, signature, commit: commit ?? null, sha256: digest, size: length });
  if (local) writeFileSync(feedFile, feed);
  else {
    say(`▶ 提交 ${config.feedRepo}/${config.feedPath}`);
    try {
      await github.writeFile(config.feedRepo, { path: config.feedPath, branch: config.feedBranch, text: feed, sha: remote?.sha, message: `navi win ${version}` });
    } catch (error) {
      die(`${FEED}没提交上：${error.message}\n包已经公开了（公开不撤回），修好后直接重跑：会沿用同一个 Release 和包、重新读一遍清单再提交。`
        + "HTTP 409 / 422 是这期间清单被别处改过，直接重跑就行。");
    }
  }
  say(`✓ 已发 Windows ${version}`);
  say(`  包：${url}`);
  say(`  ${FEED}：${local ? feedFile : feedURL(config)}`);
  return { url, signature };
}

/** 更新说明：上一版以来这个仓库里的提交标题（上一版的提交找不到时取最近 15 条）。 */
function releaseNotes(since, commit) {
  const known = since && spawnSync("git", ["cat-file", "-e", `${since}^{commit}`], { cwd: REPO }).status === 0;
  const range = known ? [`${since}..${commit || "HEAD"}`] : ["-15", commit || "HEAD"];
  const log = spawnSync("git", ["log", "--no-merges", "--format=%s", ...range, "--", ".", ":!desktop/windows/shell/tauri.conf.json"], { cwd: REPO, encoding: "utf8" });
  const subjects = (log.status === 0 ? log.stdout : "").split("\n").filter(Boolean).slice(0, 30);
  return (subjects.length ? subjects : ["小修小补"]).map((subject) => `- ${subject}`).join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      installer: { type: "string" }, version: { type: "string" }, commit: { type: "string" }, "key-file": { type: "string" },
      notes: { type: "string" }, local: { type: "string" }, "base-url": { type: "string" }, stage: { type: "boolean" }, finish: { type: "boolean" },
    },
  });
  for (const name of ["installer", "version", "key-file"]) if (!values[name]) die(`缺 --${name}`);
  if (values.stage && values.finish) die("--stage 和 --finish 只能选一个");
  await release({
    installer: values.installer, version: values.version, commit: values.commit, keyFile: resolve(values["key-file"]),
    notes: values.notes, local: values.local ? resolve(values.local) : null, baseURL: values["base-url"],
    mode: values.stage ? "stage" : values.finish ? "finish" : "single",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`✕ ${error instanceof ReleaseStop ? error.message : error.stack || error}\n`);
    process.exit(1);
  });
}
