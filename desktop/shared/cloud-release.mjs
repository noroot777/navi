// `npm run release -- 0.3.6`（desktop/release.mjs）：mac 和 Windows 一起发同一个版本号，同一个 Release（tag v<版本>）。
// 从干净的本地 main 改两边的版本号、提交、推送，再按完整 SHA 触发云端工作流 release.yml。几条口径（两边 README「发版」）：
//  · 不替你提交开发改动、不合并、不强推；版本只能往前，同一版只能是同一个提交。
//  · 动版本号之前把所有判断做完：凭证、工作流、各平台更新源、远端、这一版是不是已经（部分）发过 —— 不会推了提交才发现发不了。
//  · 从头到尾只认开始时的那个 HEAD：预检期间 main 上多了别的提交就停，不把没看过的提交发出去。
//  · 推完之后同一个提交已经有发布任务就沿用（失败的重跑它，沿用保存下来的原包），不重复触发。
//
// 平台差异由描述对象给（desktop/macos、desktop/windows 的 cloud-release.mjs 各导出一份 platform）：
//   label / name / configFile / versionFile / readConfig / readVersion(text) / writeVersion(text, version) / checkConfig?(config)
//   preflight({ github, config, version }) → state     远端更新源的核对（倒退等），不对就抛
//   checkHead(state, version, head)                     同一版是否已从别的提交发出
//   published(state, version) → true | false            这一版在这个平台的更新源里是否已经全部发出（只发了一部分就抛）
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub, resolveToken } from "./release-github.mjs";
import { WORKFLOW, assertVersion, compareVersions, runName } from "./release-version.mjs";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`git ${args[0]} 失败：${result.stderr || result.stdout || result.signal}`);
  return result.stdout.trim();
}

function githubRemote(url, repo) {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)\/?$/);
  return match?.[1].replace(/\.git$/, "").toLowerCase() === repo.toLowerCase();
}

async function previousRun(github, repo, title) {
  for (let page = 1; ; page++) {
    const { json } = await github.call("GET", `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`);
    const runs = json.workflow_runs ?? [];
    const existing = runs.find((run) => run.display_title === title);
    if (existing) return existing;
    if (runs.length < 100) return null;
  }
}

/** 返回这次的工作流运行（新触发的或沿用的）；所有平台都已发过这一版时返回 null。 */
export async function releaseCloud(platforms, version, { cwd, github, say = console.log } = {}) {
  assertVersion(version);
  if (git(cwd, ["branch", "--show-current"]) !== "main") throw new Error("只从本地 main 发布；先整理并合入需要发布的代码。");
  if (git(cwd, ["status", "--porcelain"])) throw new Error("工作区有没提交的改动：先整理提交，再发版（不会替你提交开发改动）。");
  const head = git(cwd, ["rev-parse", "HEAD"]);
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
  const repo = jobs[0].config.releaseRepo;
  const tag = `${jobs[0].config.tagPrefix}${version}`;
  if (jobs.some((job) => job.config.releaseRepo !== repo || `${job.config.tagPrefix}${version}` !== tag)) {
    throw new Error("各平台的装包仓库或 Release tag 不同：一个版本只能有一个 Release。");
  }
  if (!github) {
    const auth = resolveToken();
    if (!auth) throw new Error("没有 GitHub 凭证：设置 GH_TOKEN，或登录 gh；本地凭证需要 navi 的 Actions 读写权限。");
    github = new GitHub(auth.token);
  }
  if ((await github.call("GET", `/repos/${repo}`)).json.default_branch !== "main") throw new Error("发布仓库默认分支不是 main，停止发布。");
  const { status: found, json: workflow } = await github.call("GET", `/repos/${repo}/actions/workflows/${WORKFLOW}`, { allow: [404] });
  if (found === 404) {
    throw new Error(`GitHub 上还没有发布工作流 ${WORKFLOW}：它只在本地 main 里。先 git push origin main 把它推上去，再重新执行同一命令。没有修改版本或推送。`);
  }
  if (workflow.state !== "active") throw new Error(`发布工作流 ${WORKFLOW} 未启用：先将工作流合入 main 并启用 Actions。`);
  await previousRun(github, repo, runName(version, head));
  for (const job of jobs) job.state = await job.platform.preflight({ github, config: job.config, version });

  say("▶ 核对 origin/main（不自动合并、不强推）");
  git(cwd, ["fetch", "--no-tags", "origin", "main"]);
  const remote = git(cwd, ["rev-parse", "FETCH_HEAD"]);
  if (spawnSync("git", ["merge-base", "--is-ancestor", remote, head], { cwd }).status !== 0) {
    throw new Error("远端 main 有本地尚未包含的提交：先自行同步、处理分叉，再发布。没有修改版本或推送。");
  }
  // 只在开始时那个 main 上动：别处切了分支、多了提交、改了文件，都停
  const leftMain = () => git(cwd, ["branch", "--show-current"]) !== "main";
  const changed = () => leftMain() || git(cwd, ["rev-parse", "HEAD"]) !== head || git(cwd, ["status", "--porcelain"])
    || jobs.some((job) => readFileSync(join(cwd, job.platform.versionFile), "utf8") !== job.original);
  if (changed()) throw new Error("预检期间本地 main 或工作区被别处改动了（切了分支、多了提交或改了文件），停止发布：只发开始时核对过的那个提交。");
  for (const job of jobs) job.platform.checkHead(job.state, version, head);

  // 推之前定下要做的事：沿用已有任务 / 已全部发过 / 只发了一部分（拒）/ 新发
  const bumps = jobs.filter((job) => job.current !== version);
  const existing = bumps.length ? null : await previousRun(github, repo, runName(version, head));
  if (!existing) {
    const published = jobs.map((job) => job.platform.published(job.state, version));
    if (published.every(Boolean)) {
      say(`✓ ${version} 已经发过了：https://github.com/${repo}/releases/tag/${tag}（没有重新发包）`);
      return null;
    }
    if (published.some(Boolean)) {
      const done = jobs.filter((_, index) => published[index]).map((job) => job.platform.name).join("、");
      throw new Error(`${version} 只有 ${done} 发过，而且没有可恢复的原工作流：一个版本只能有一个 Release，改用新的版本号。没有修改版本或推送。`);
    }
  }

  if (bumps.length) {
    for (const bump of bumps) {
      bump.next = bump.platform.writeVersion(bump.original, version);
      writeFileSync(join(cwd, bump.platform.versionFile), bump.next);
    }
    const message = `chore(release): 版本号 ${version}（${bumps.map((bump) => bump.platform.label).join("、")}）`;
    try {
      if (leftMain()) throw new Error("写版本号期间本地切走了 main：没有提交、没有推送。");
      git(cwd, ["commit", "--only", "-m", message, "--", ...bumps.map((bump) => bump.platform.versionFile)]);
    } catch (error) {
      // 只还原仍是自己写出的那份的文件：提交等待期间编辑器、钩子可能改过它，HEAD 没动不代表文件没被别人碰过
      const touched = [];
      if (git(cwd, ["rev-parse", "HEAD"]) === head) {
        for (const bump of bumps) {
          const path = join(cwd, bump.platform.versionFile);
          if (readFileSync(path, "utf8") === bump.next) writeFileSync(path, bump.original);
          else touched.push(bump.platform.versionFile);
        }
      }
      if (touched.length) throw new Error(`${error.message}\n${touched.join("、")} 在提交期间被别处改过：原样留着没还原（版本号改动也在里面），检查后自行处理。`);
      throw error;
    }
  }
  const commit = git(cwd, ["rev-parse", "HEAD"]);
  if (leftMain() || (bumps.length ? git(cwd, ["rev-parse", "HEAD^"]) : commit) !== head) throw new Error("提交期间本地 main 被别处改动了（切了分支或多了提交）：没有推送；检查后重试。");
  if (git(cwd, ["status", "--porcelain"])) throw new Error("提交期间出现额外改动：版本提交保留，没有推送；检查工作区后重试。");
  say(`▶ 推送 main：${commit}`);
  git(cwd, ["push", "origin", `${commit}:refs/heads/main`]);

  if (existing) {
    if (existing.status === "completed" && existing.conclusion !== "success") {
      await github.call("POST", `/repos/${repo}/actions/runs/${existing.id}/rerun`, { body: {} });
      say("▶ 重跑原工作流，沿用已保存的原包");
    }
    say(`${existing.conclusion === "success" ? "✓ 已成功发布" : "✓ 已有发布任务"}：${existing.html_url}`);
    return existing;
  }
  let run;
  try {
    run = (await github.call("POST", `/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      body: { ref: "main", inputs: { version, source_sha: commit, publish: "true" } },
      headers: { "x-github-api-version": "2026-03-10" },
    })).json;
  } catch (error) {
    throw new Error(`代码已推送（${commit}），但云端触发未确认：${error.message}\n检查 Actions 写权限后，重新执行同一命令；不会再创建版本提交。`);
  }
  say(`✓ 云端已接单：${run?.html_url || `https://github.com/${repo}/actions/workflows/${WORKFLOW}`}`);
  say(`  发完是同一个 Release：https://github.com/${repo}/releases/tag/${tag}`);
  say("可以退出终端或关电脑；这不是发布完成通知，构建与发布结果以 Actions 为准。");
  return run;
}
