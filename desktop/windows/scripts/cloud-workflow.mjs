// 云端发布 Windows 版的各步（.github/workflows/release-win.yml 调；对应 mac 的 cloud-workflow.mjs）：
//
//   validate   核对这次运行：只认 main 上的 workflow_dispatch、源码提交在 main 上、源码里的版本号就是参数里那一版、
//              运行名对得上参数；找这次运行里有没有保存过的原始产物（重跑时沿用它，不重新构建）
//   build      从那个提交构建安装包，连同清单（版本、提交、sha256）放进 payload/，供下一步存成恢复产物
//   restore    用保存下来的原始产物（重跑 / 发布那一步），核对清单和安装包的 sha256
//   verify     核对产物：清单与参数一致、安装包是 PE 文件、大小与 sha256 对得上
//   publish    签名并发布（只在 publish=true 的那一步、拿到 Secret 之后）：私钥落成 0600 的临时文件，用完即删。
//              Secret 和 mac 版共用：MAC_RELEASE_TOKEN 传包、提交清单，MAC_SPARKLE_PRIVATE_KEY 签名（同一把 Ed25519，见 minisign.mjs）
//
// 构建那一步拿不到发布 Secret（release-win.yml 里只给 publish 那一步），所以构建出来的包不经签名就先存成恢复产物；
// 签名只签这一份原包，重跑发布时也是同一份 —— 重新构建出来的字节不一样，签名就和已公开的那个对不上了。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHub } from "../../shared/release-github.mjs";
import { readPublicFeed } from "../../shared/release-public-feed.mjs";
import { assertVersion, compareVersions } from "../../shared/release-version.mjs";
import { installerName, parseFeed, readConfig, runName, sourceVersion, tagFor } from "./release-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG = "desktop/windows/release.json";
const VERSION_FILE = "desktop/windows/shell/tauri.conf.json";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const recoveryName = (runId) => `win-release-${runId}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} 失败（${result.status ?? result.signal}）\n${result.stderr ?? ""}${result.stdout ?? ""}`);
  return result.stdout?.trim();
}

export function workflowRequest(env) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "只接受显式 workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "只允许从 main 运行发布工作流");
  assert.match(env.NAVI_WIN_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/, "需要完整源码提交 SHA");
  assert.match(env.GITHUB_RUN_ID ?? "", /^\d+$/, "需要工作流运行 ID");
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/, "需要工作流尝试编号");
  assert.ok(["true", "false"].includes(env.NAVI_WIN_PUBLISH), "publish 只能是 true 或 false");
  return { version: assertVersion(env.NAVI_WIN_VERSION), source: env.NAVI_WIN_SOURCE_SHA, runId: env.GITHUB_RUN_ID, publish: env.NAVI_WIN_PUBLISH === "true" };
}

export async function prepareWorkflow({ env = process.env, root = ROOT, github, publicGithub } = {}) {
  const request = workflowRequest(env);
  const config = readConfig(join(root, CONFIG));
  assert.equal(env.GITHUB_REPOSITORY, config.releaseRepo, "工作流仓库与发版配置不同");
  assert.equal(run("git", ["merge-base", "--is-ancestor", request.source, "origin/main"], { cwd: root }), "");
  assert.equal(sourceVersion(run("git", ["show", `${request.source}:${VERSION_FILE}`], { cwd: root })), request.version, "源码里的版本与发布参数不同");
  github ??= new GitHub(env.GH_TOKEN);
  publicGithub ??= { readFile: readPublicFeed };
  const base = `/repos/${config.releaseRepo}/actions/runs/${request.runId}`;
  const metadata = (await github.call("GET", base)).json;
  assert.equal(metadata.event, "workflow_dispatch");
  assert.equal(metadata.head_branch, "main");
  assert.equal(metadata.display_title, runName(request.version, request.source, request.publish), "工作流名称与发布参数不符");
  const artifacts = (await github.call("GET", `${base}/artifacts?per_page=100`)).json.artifacts ?? [];
  const artifact = artifacts.find((entry) => entry.name === recoveryName(request.runId));
  if (artifact?.expired) throw new Error("原始恢复产物已经过期，停止发布；请发一个新版本，不能同号覆盖或重封旧包。");
  if (!artifact && request.publish) {
    const latest = parseFeed((await publicGithub.readFile(config.feedRepo, config.feedPath, config.feedBranch))?.text);
    if (latest && compareVersions(request.version, latest.version) <= 0) {
      throw new Error(`更新清单已经是 ${latest.version}：补收尾请重跑保留原始产物的工作流，否则使用新版本。`);
    }
  }
  if (!artifact && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    const tag = tagFor(config, request.version);
    for (let page = 1; ; page++) {
      const releases = (await github.call("GET", `/repos/${config.releaseRepo}/releases?per_page=100&page=${page}`)).json;
      if (releases.some((entry) => entry.tag_name === tag)) throw new Error("已存在这一版的 Release，但没有原始恢复产物；停止重封，改发新版本。");
      if (releases.length < 100) break;
    }
  }
  const directory = join(env.RUNNER_TEMP, "navi-win-release");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `restore=${artifact ? "true" : "false"}\nartifact_id=${artifact?.id ?? ""}\n`);
  return request;
}

export function verifyBundle(directory, expected) {
  const payload = join(directory, "payload");
  const manifest = JSON.parse(readFileSync(join(payload, "manifest.json"), "utf8"));
  for (const field of ["version", "source", "runId", "publish"]) assert.equal(manifest[field], expected[field], `恢复产物 ${field} 不符`);
  const installer = join(payload, installerName(manifest.version));
  assert.ok(existsSync(installer), `恢复产物里没有 ${installerName(manifest.version)}`);
  assert.equal(statSync(installer).size, manifest.size, "安装包大小与恢复清单不符");
  assert.equal(sha256(installer), manifest.sha256, "安装包与保存的原包不同");
  assert.equal(readFileSync(installer).subarray(0, 2).toString("latin1"), "MZ", "安装包不是 Windows 可执行文件");
  assert.match(manifest.runtime ?? "", /^[a-f0-9]{64}$/, "恢复清单里没有自带运行时的 id");
  return { manifest, installer };
}

export function buildBundle(directory, request, { root = ROOT, build = true } = {}) {
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: root }), request.source, "未检出要求的源码提交");
  assert.equal(sourceVersion(readFileSync(join(root, VERSION_FILE), "utf8")), request.version);
  const out = join(root, "desktop/windows/build");
  // 不带签名私钥构建：签名在 publish 那一步做（构建这一步拿不到 Secret）。更新公钥和更新源按 release.json。
  const env = { ...process.env, NAVI_WIN_BUILD_VERSION: request.version };
  for (const name of ["NAVI_WIN_UPDATER_KEY_FILE", "NAVI_WIN_FEED_URL", "NAVI_WIN_UPDATER_PUBLIC_KEY", "NAVI_WIN_REHEARSAL_ENV", "NAVI_WIN_SKIP_RUNTIME"]) delete env[name];
  if (build) run(process.execPath, [join(root, "desktop/windows/scripts/build-shell.mjs"), out], { cwd: root, stdio: "inherit", env });
  const payload = join(directory, "payload");
  if (existsSync(payload)) throw new Error("恢复产物目录已存在，不能覆盖后重新封包");
  mkdirSync(payload, { recursive: true });
  const name = installerName(request.version);
  copyFileSync(join(out, name), join(payload, name));
  const runtime = JSON.parse(readFileSync(join(out, "Navi", "runtime", ".runtime.json"), "utf8")).id;
  const manifest = { ...request, runtime, size: statSync(join(payload, name)).size, sha256: sha256(join(payload, name)) };
  writeFileSync(join(payload, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyBundle(directory, request).manifest;
}

export function withSigningKey(env, operation) {
  if (!env.GH_TOKEN?.trim()) throw new Error("缺少 MAC_RELEASE_TOKEN Secret");
  if (!env.MAC_SPARKLE_PRIVATE_KEY?.trim()) throw new Error("缺少 MAC_SPARKLE_PRIVATE_KEY Secret");
  const keyDirectory = join(env.RUNNER_TEMP, "navi-win-signing");
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  const key = join(keyDirectory, "updater.key");
  try {
    writeFileSync(key, env.MAC_SPARKLE_PRIVATE_KEY.trim(), { mode: 0o600, flag: "wx" });
    const childEnv = { ...env };
    delete childEnv.MAC_SPARKLE_PRIVATE_KEY;
    return operation(key, childEnv);
  } finally {
    rmSync(keyDirectory, { recursive: true, force: true });
  }
}

export function publishBundle(directory, request, { env = process.env } = {}) {
  assert.equal(request.publish, true, "演练不执行公开发布");
  const { installer, manifest } = verifyBundle(directory, request);
  return withSigningKey(env, (key, childEnv) => run(process.execPath, [
    join(ROOT, "desktop/windows/scripts/release.mjs"),
    "--installer", installer, "--version", manifest.version, "--commit", manifest.source, "--key-file", key,
  ], { env: childEnv, stdio: "inherit" }));
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") return prepareWorkflow();
  const directory = join(process.env.RUNNER_TEMP, "navi-win-release");
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
  if (command === "build") return buildBundle(directory, request);
  if (command === "restore" || command === "verify") return verifyBundle(directory, request);
  if (command === "publish") return publishBundle(directory, request);
  throw new Error("需要 validate / build / restore / verify / publish 子命令");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
}
