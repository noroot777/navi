// 合并发布：一个版本一个 Release（tag <tagPrefix><版本>，即 v0.3.6），里面是 Apple 芯片 dmg、Intel dmg、Windows 安装包三个文件。
// .github/workflows/release.yml 的 publish job（macOS runner：dmg 的 Sparkle 签名和 codesign/hdiutil 核对要在 mac 上做）调：
//
//   locate    三份原包都要在这次运行里存过（构建 job 的恢复产物）：按 NAVI_RELEASE_DIR 分目录写好 request.json，输出产物 id
//   restore   三份原包解开并核对（大小、sha256、app 内容摘要）
//   publish   ① 没有这一版的 Release 就建草稿（标题、说明是三个平台合起来的）
//             ② 三个包各自签名、传进草稿、经 API 下回核对（各平台 release.mjs --stage）
//             ③ 三个都在草稿里了才公开，核对 tag 打在构建提交上
//             ④ 各平台推自己的更新源（两份 appcast + Mac 下载页、Windows latest.json；release.mjs --finish），一个没推成不挡另一个
//
// 不变量：Release 公开之前三个包都在草稿里核对过；公开之后不撤回、不往里补没核对过的包，哪一步失败都只靠重跑往前补
// （重跑沿用这次运行存下的原包，签名、上传、公开、更新源每一步都认得出做过了）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mac from "../macos/scripts/cloud-workflow.mjs";
import { distributionName } from "../macos/scripts/architecture.mjs";
import { parseItems } from "../macos/scripts/appcast.mjs";
import { itemDetails, readConfig as readMacConfig } from "../macos/scripts/release-state.mjs";
import * as win from "../windows/scripts/cloud-workflow.mjs";
import { installerName, readConfig as readWinConfig, tagFor } from "../windows/scripts/release-state.mjs";
import { GitHub } from "./release-github.mjs";
import { ReleaseStop, tagTarget } from "./release-publish.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 三份包：哪个平台、放在哪个目录、产物 id 在 GITHUB_OUTPUT 里叫什么。 */
export const PARTS = [
  { key: "mac_arm64", label: "Apple 芯片", flow: mac, dir: "navi-mac-release-arm64", env: { NAVI_MAC_ARCH: "arm64" } },
  { key: "mac_x64", label: "Intel", flow: mac, dir: "navi-mac-release-x64", env: { NAVI_MAC_ARCH: "x64" } },
  { key: "win", label: "Windows", flow: win, dir: "navi-win-release", env: {} },
];

const partEnv = (part, env) => ({ ...env, ...part.env, NAVI_RELEASE_DIR: join(env.RUNNER_TEMP, part.dir) });
const request = (part, env) => JSON.parse(readFileSync(join(env.RUNNER_TEMP, part.dir, "request.json"), "utf8"));

/** 这一版的 tag 和三个文件名；mac 与 Windows 的配置必须指向同一个装包仓库、同一个 tag。 */
export function releasePlan(version, { root = ROOT } = {}) {
  const macConfig = readMacConfig(join(root, "desktop/macos/release.json"));
  const winConfig = readWinConfig(join(root, "desktop/windows/release.json"));
  assert.equal(macConfig.releaseRepo, winConfig.releaseRepo, "mac 与 Windows 的装包仓库不同");
  const tag = `${macConfig.tagPrefix}${version}`;
  assert.equal(tagFor(winConfig, version), tag, "mac 与 Windows 的 Release tag 不同：一个版本只能有一个 Release");
  return {
    repo: macConfig.releaseRepo, tag, macConfig,
    assets: [distributionName(version, "arm64"), distributionName(version, "x64"), installerName(version)],
  };
}

export async function locate({ env = process.env, prepare = (part, partEnv) => part.flow.prepareWorkflow({ env: partEnv }) } = {}) {
  const outputs = [];
  for (const part of PARTS) {
    const scratch = mkdtempSync(join(tmpdir(), "navi-release-locate-"));
    try {
      const output = join(scratch, "output");
      await prepare(part, { ...partEnv(part, env), GITHUB_OUTPUT: output });
      const lines = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => line.split("=")));
      if (lines.restore !== "true") throw new Error(`这次运行里没有 ${part.label} 的原包：发布只用构建 job 存下来的那一份，不重新构建。`);
      outputs.push(`${part.key}=${lines.artifact_id}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
  return outputs;
}

export function restore({ env = process.env } = {}) {
  for (const part of PARTS) {
    const directory = join(env.RUNNER_TEMP, part.dir);
    if (part.flow === mac) mac.restoreBundle(directory, request(part, env));
    else win.verifyBundle(directory, request(part, env));
  }
}

export async function publish({ env = process.env, root = ROOT, github = new GitHub(env.GH_TOKEN), stage, finish, say = console.log } = {}) {
  const requests = PARTS.map((part) => request(part, env));
  for (const field of ["version", "source", "runId"]) {
    assert.equal(new Set(requests.map((entry) => entry[field])).size, 1, `三份原包的 ${field} 不一致`);
  }
  const [{ version, source, publish: publishing }] = requests;
  assert.equal(publishing, true, "演练不执行公开发布");
  const plan = releasePlan(version, { root });
  stage ??= (part) => part.flow.publishBundle(join(env.RUNNER_TEMP, part.dir), request(part, env), { env, mode: "stage" });
  finish ??= (part) => part.flow.publishBundle(join(env.RUNNER_TEMP, part.dir), request(part, env), { env, mode: "finish" });

  // ① 草稿
  const target = await tagTarget(github, plan.repo, source, plan.tag);
  let release = await github.findRelease(plan.repo, plan.tag);
  if (!release) {
    say(`▶ 在 ${plan.repo} 建草稿 Release ${plan.tag}（tag 公开时打在构建提交 ${source}）`);
    const notes = await releaseNotes(github, plan.macConfig, version, source, root);
    release = await github.createDraftRelease(plan.repo, { tag: plan.tag, target, name: `Navi ${version}`, body: releaseBody(version, notes, plan) });
  }

  // ② 三个包进草稿
  for (const part of PARTS) {
    say(`▶ ${part.label}：签名、传进草稿并核对`);
    await stage(part);
  }

  // ③ 齐了才公开
  release = await github.findRelease(plan.repo, plan.tag);
  const missing = plan.assets.filter((name) => !(release?.assets ?? []).some((asset) => asset.name === name));
  if (missing.length) throw new ReleaseStop(`Release ${plan.tag} 里还缺 ${missing.join("、")}：没有公开，重跑会接着补。`);
  if (release.draft) {
    say(`▶ 三个包都在草稿里核对过了，公开 Release ${plan.tag}`);
    try {
      release = await github.publishRelease(plan.repo, release, target);
    } catch (error) {
      throw new ReleaseStop(`公开 Release ${plan.tag} 时出错（${error.message}）：它可能已经公开了。更新源都没有推；直接重跑，会认出它接着补。`);
    }
  }
  const tagged = await github.tagCommit(plan.repo, plan.tag);
  if (tagged !== target) {
    throw new ReleaseStop(`Release ${plan.tag} 已经公开，但 tag 指着 ${tagged ?? "（没有）"}，不是构建提交 ${target}：更新源都没有推。请核查，改用新版本发布。`);
  }

  // ④ 各自的更新源：一个没推成不挡另一个，最后一并报
  const failures = [];
  for (const part of PARTS) {
    try {
      say(`▶ ${part.label}：核对公开地址、推更新源`);
      await finish(part);
    } catch (error) {
      failures.push(`${part.label}：${error.message}`);
    }
  }
  if (failures.length) throw new ReleaseStop(`Release ${plan.tag} 已经公开（公开不撤回），这几份更新源没推成，重跑会只补它们：\n${failures.join("\n")}`);
  say(`✓ 已发 ${version}：https://github.com/${plan.repo}/releases/tag/${plan.tag}`);
  return release;
}

/** 更新说明：上一版（Apple 芯片 appcast 里不是这一版的最新一条）以来的提交标题，版本号提交不算。 */
async function releaseNotes(github, config, version, source, root) {
  const feed = await github.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const since = parseItems(feed?.text ?? "").map(itemDetails).find((item) => item.shortVersion !== version && item.commit)?.commit;
  const known = since && spawnSync("git", ["cat-file", "-e", `${since}^{commit}`], { cwd: root }).status === 0;
  const log = spawnSync("git", ["log", "--no-merges", "--format=%s", ...(known ? [`${since}..${source}`] : ["-15", source])], { cwd: root, encoding: "utf8" });
  const subjects = (log.status === 0 ? log.stdout : "").split("\n").filter((subject) => subject && !/^chore\((release|mac|win)\): 版本号/.test(subject)).slice(0, 30);
  return (subjects.length ? subjects : ["小修小补"]).map((subject) => `- ${subject}`).join("\n");
}

export function releaseBody(version, notes, plan) {
  const [arm, intel, setup] = plan.assets;
  return [
    notes,
    "",
    "## 下载",
    "",
    `- **Mac · Apple 芯片（M 系列）**：${arm}`,
    `- **Mac · Intel**：${intel}`,
    `- **Windows（x64）**：${setup}`,
    "",
    "Mac：打开 dmg，把 Navi 拖进「应用程序」；要求 macOS 14+，两种芯片的包不能混用。第一次打开被系统拦住时的处理见 "
      + `https://github.com/${plan.repo}#下载-mac-版。装着改名前的 Ash.app：装好打开一次 Navi，它会接过 Ash 的设置、数据和登录项。`,
    "",
    "Windows：双击安装包（装在自己的用户目录下，不要管理员）。提示「未知发布者」时点「更多信息」→「仍要运行」。",
    "",
    "已经装了的会自己提示更新。",
  ].join("\n");
}

async function main() {
  const command = process.argv[2];
  if (command === "locate") return locate();
  if (command === "restore") return restore();
  if (command === "publish") return publish();
  throw new Error("需要 locate / restore / publish 子命令");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
}
