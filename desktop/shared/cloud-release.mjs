// 云端发版的公共流程：`npm run release:mac` / `release:win` 各发一个平台，`npm run release` 两个一起发同一个版本号。
// 从干净的本地 main 改版本号、提交、推送，再按完整 SHA 触发各平台的工作流。几条口径（两边 README「发版」）：
//  · 不替你提交开发改动、不合并、不强推；版本只能往前，同一版只能是同一个提交。
//  · 先把所有平台的预检都做完（凭证、工作流、更新源、远端）才动版本号：任何一个平台不行就谁都不发，不会只发出去一半。
//  · 所有要改的版本号进同一个提交、推一次，各平台用同一个 SHA 触发。
//  · 推完之后同一个提交已经有发布任务就沿用（失败的重跑它，沿用保存下来的原产物），不重复触发。
//
// 平台差异由描述对象给（desktop/macos、desktop/windows 的 cloud-release.mjs 各导出一份 platform）：
//   label / name / configFile / versionFile / workflow / runName(version, commit)
//   readVersion(text) / writeVersion(text, version)
//   preflight({ github, config, version, cwd }) → state       远端更新源的核对（倒退等），不对就抛
//   checkHead(state, version, head)                           同一版是否已从别的提交发出
//   published(state, version) → 说明 | null                   没有原工作流时：已全部发布就返回说明（不再触发），发了一部分就抛
//   rerunNote / notes(config) → 追加的几行
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub, resolveToken } from "./release-github.mjs";
import { assertVersion, compareVersions } from "./release-version.mjs";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`git ${args[0]} 失败：${result.stderr || result.stdout || result.signal}`);
  return result.stdout.trim();
}

function githubRemote(url, repo) {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)\/?$/);
  return match?.[1].replace(/\.git$/, "").toLowerCase() === repo.toLowerCase();
}

async function previousRun(github, repo, workflow, title) {
  for (let page = 1; ; page++) {
    const { json } = await github.call("GET", `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`);
    const runs = json.workflow_runs ?? [];
    const existing = runs.find((run) => run.display_title === title);
    if (existing) return existing;
    if (runs.length < 100) return null;
  }
}

/** 发 platforms 里的每一个平台，全用 version。返回与 platforms 一一对应的结果（工作流运行 / null = 已发布、没再触发）。 */
export async function releasePlatforms(platforms, version, { cwd, github, say = console.log } = {}) {
  assertVersion(version);
  if (git(cwd, ["branch", "--show-current"]) !== "main") throw new Error("只从本地 main 发布；先整理并合入需要发布的代码。");
  if (git(cwd, ["status", "--porcelain"])) throw new Error("工作区有没提交的改动：先整理提交，再发版（不会替你提交开发改动）。");
  const origin = git(cwd, ["config", "--get", "remote.origin.url"]);
  const pushUrls = spawnSync("git", ["config", "--get-all", "remote.origin.pushurl"], { cwd, encoding: "utf8" });
  const jobs = platforms.map((platform) => {
    const config = platform.readConfig(join(cwd, platform.configFile));
    if (!githubRemote(origin, config.releaseRepo)) throw new Error(`origin 不指向 GitHub ${config.releaseRepo}，没有推送或修改版本。`);
    if (pushUrls.status === 0 && pushUrls.stdout.trim().split("\n").some((url) => !githubRemote(url, config.releaseRepo))) {
      throw new Error("origin 的 pushurl 指向别处，没有推送或修改版本。");
    }
    platform.checkConfig?.(config);
    const original = readFileSync(join(cwd, platform.versionFile), "utf8");
    const current = platform.readVersion(original);
    if (compareVersions(version, current) < 0) throw new Error(`不能把 ${platform.name} 的源码版本从 ${current} 倒退到 ${version}`);
    return { platform, config, original, current };
  });
  if (!github) {
    const auth = resolveToken();
    if (!auth) throw new Error("没有 GitHub 凭证：设置 GH_TOKEN，或登录 gh；本地凭证需要 navi 的 Actions 读写权限。");
    github = new GitHub(auth.token);
  }
  const before = git(cwd, ["rev-parse", "HEAD"]);
  for (const job of jobs) {
    const { platform, config } = job;
    const repo = (await github.call("GET", `/repos/${config.releaseRepo}`)).json;
    if (repo.default_branch !== "main") throw new Error("发布仓库默认分支不是 main，停止发布。");
    const workflow = (await github.call("GET", `/repos/${config.releaseRepo}/actions/workflows/${platform.workflow}`)).json;
    if (workflow.state !== "active") throw new Error(`${platform.name} 发布工作流未启用：先将工作流合入 main 并启用 Actions。`);
    await previousRun(github, config.releaseRepo, platform.workflow, platform.runName(version, before));
    job.state = await platform.preflight({ github, config, version, cwd });
  }
  say("▶ 核对 origin/main（不自动合并、不强推）");
  git(cwd, ["fetch", "--no-tags", "origin", "main"]);
  const remote = git(cwd, ["rev-parse", "FETCH_HEAD"]);
  if (spawnSync("git", ["merge-base", "--is-ancestor", remote, "HEAD"], { cwd }).status !== 0) {
    throw new Error("远端 main 有本地尚未包含的提交：先自行同步、处理分叉，再发布。没有修改版本或推送。");
  }
  const head = git(cwd, ["rev-parse", "HEAD"]);
  for (const job of jobs) job.platform.checkHead(job.state, version, head);
  if (git(cwd, ["status", "--porcelain"]) || jobs.some((job) => readFileSync(join(cwd, job.platform.versionFile), "utf8") !== job.original)) {
    throw new Error("预检期间工作区被别处修改了，停止发布。");
  }

  const bumps = jobs.filter((job) => job.current !== version).map((job) => ({ ...job, next: job.platform.writeVersion(job.original, version) }));
  if (bumps.length) {
    for (const bump of bumps) writeFileSync(join(cwd, bump.platform.versionFile), bump.next);
    const scope = bumps.length === 1 ? bumps[0].platform.label : "release";
    const message = bumps.length === 1 ? `chore(${scope}): 版本号 ${version}` : `chore(${scope}): 版本号 ${version}（${bumps.map((bump) => bump.platform.label).join("、")}）`;
    try {
      git(cwd, ["commit", "--only", "-m", message, "--", ...bumps.map((bump) => bump.platform.versionFile)]);
    } catch (error) {
      if (git(cwd, ["rev-parse", "HEAD"]) === head) {
        for (const bump of bumps) {
          const path = join(cwd, bump.platform.versionFile);
          if (readFileSync(path, "utf8") === bump.next) writeFileSync(path, bump.original);
        }
      }
      throw error;
    }
  }
  const commit = git(cwd, ["rev-parse", "HEAD"]);
  if (git(cwd, ["status", "--porcelain"])) throw new Error("提交期间出现额外改动：版本提交保留，没有推送；检查工作区后重试。");
  say(`▶ 推送 main：${commit}`);
  git(cwd, ["push", "origin", `${commit}:refs/heads/main`]);

  // 推上去以后逐个平台触发：一个没触发成，另一个照样触发，最后一并报；重跑同一命令只补没触发的（不会再建版本提交）。
  const results = [];
  const failures = [];
  for (const { platform, config, state } of jobs) {
    try {
      results.push(await dispatch(github, platform, config, state, version, commit, say));
    } catch (error) {
      results.push(undefined);
      failures.push(platforms.length > 1 ? `${platform.name}：${error.message}` : error.message);
    }
  }
  if (failures.length) {
    throw new Error(`代码已推送（${commit}），但云端触发未确认：${failures.join("\n")}\n检查 Actions 写权限后，重新执行同一命令；不会再创建版本提交。`);
  }
  say("可以退出终端或关电脑；这不是发布完成通知，构建与发布结果以 Actions 为准。");
  return results;
}

async function dispatch(github, platform, config, state, version, commit, say) {
  const existing = await previousRun(github, config.releaseRepo, platform.workflow, platform.runName(version, commit));
  if (existing) {
    if (existing.status === "completed" && existing.conclusion !== "success") {
      await github.call("POST", `/repos/${config.releaseRepo}/actions/runs/${existing.id}/rerun`, { body: {} });
      say(`▶ ${platform.name}：重跑原工作流，${platform.rerunNote}`);
    }
    say(`${existing.conclusion === "success" ? "✓ 已成功发布" : "✓ 已有发布任务"}（${platform.name}）：${existing.html_url}`);
    for (const line of platform.notes?.(config) ?? []) say(line);
    return existing;
  }
  const already = platform.published(state, version, config);
  if (already) {
    say(`✓ ${platform.name}：${already}（没有重新发包）`);
    return null;
  }
  const run = (await github.call("POST", `/repos/${config.releaseRepo}/actions/workflows/${platform.workflow}/dispatches`, {
    body: { ref: "main", inputs: { version, source_sha: commit, publish: "true" } },
    headers: { "x-github-api-version": "2026-03-10" },
  })).json;
  say(`✓ ${platform.name} 云端已接单：${run?.html_url || `https://github.com/${config.releaseRepo}/actions/workflows/${platform.workflow}`}`);
  return run;
}

/** 各平台 cloud-release.mjs 的命令行入口：`<命令> -- <版本>`。 */
export function cli(usage, run) {
  if (process.argv[2] === "--help") {
    console.log(usage);
  } else if (process.argv.length !== 3) {
    console.error(usage.split("\n")[0]);
    process.exitCode = 1;
  } else {
    run(process.argv[2]).catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
  }
}
