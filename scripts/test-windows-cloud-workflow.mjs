// Windows 云端发版（.github/workflows/release.yml 的 build-win、desktop/windows/scripts/cloud-workflow.mjs，在 mac 上也跑）：
//   · 工作流只认 main 上的 workflow_dispatch；源码提交在 main 上、源码版本号就是参数那一版、运行名对得上参数；
//     重跑沿用这次运行保存的原包，原包过期、清单已是这一版又没有原包、重跑时已有 Release 又没有原包，都拒绝
//   · 原包：清单（版本、提交、运行号、sha256、大小、运行时 id）与安装包一一对得上，改了一个字节就拒
//   · 私钥：落成 0600 的临时文件、子进程环境里没有它、失败也删；publish=false 不发布
//   · 工作流文件：build-win 在 windows-latest 上、拿不到发布 Secret 的值、冒烟过了才存原包（合并发布那一段见 test-release-together.mjs）
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, prepareWorkflow, publishBundle, recoveryName, verifyBundle, withSigningKey, workflowRequest } from "../desktop/windows/scripts/cloud-workflow.mjs";
import { renderFeed, runName } from "../desktop/windows/scripts/release-state.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-windows-cloud-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", feedPath: "navi/win/latest.json", tagPrefix: "navi-win-v", publicKey: "PK" };
const conf = (version) => `{\n  "productName": "Navi",\n  "version": "${version}",\n  "identifier": "dev.navi.win"\n}\n`;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function repo(name, version = "0.1.0") {
  const dir = join(temporary, name);
  mkdirSync(join(dir, "desktop/windows/shell"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "release test");
  git(dir, "config", "user.email", "release@example.invalid");
  git(dir, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "desktop/windows/shell/tauri.conf.json"), conf(version));
  writeFileSync(join(dir, "desktop/windows/release.json"), JSON.stringify(config));
  writeFileSync(join(dir, "business.txt"), "already reviewed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const feedText = (version, commit) => renderFeed({ version, notes: "", url: `https://x/Navi-${version}-x64-setup.exe`, signature: "S", commit, sha256: "0".repeat(64), size: 1 });

try {
  // ── 请求与运行核对 ────────────────────────────────────────────────────
  const root = repo("workflow");
  const source = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", source);
  const env = (extra = {}) => ({
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "o/app", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1",
    NAVI_WIN_VERSION: "0.1.0", NAVI_WIN_SOURCE_SHA: source, NAVI_WIN_PUBLISH: "true", RUNNER_TEMP: join(temporary, "runner"), ...extra,
  });
  {
    assert.throws(() => workflowRequest(env({ GITHUB_EVENT_NAME: "push" })), /workflow_dispatch/);
    assert.throws(() => workflowRequest(env({ GITHUB_REF: "refs/heads/dev" })), /main/);
    assert.throws(() => workflowRequest(env({ NAVI_WIN_SOURCE_SHA: "abc" })), /完整/);
    assert.throws(() => workflowRequest(env({ NAVI_WIN_PUBLISH: "yes" })), /publish/);
    const github = (state) => ({
      async call(method, url) {
        if (url === "/repos/o/app/actions/runs/77") return { json: { event: "workflow_dispatch", head_branch: "main", display_title: state.title ?? runName("0.1.0", source, true) } };
        if (url.startsWith("/repos/o/app/actions/runs/77/artifacts")) return { json: { artifacts: state.artifacts ?? [] } };
        if (url.startsWith("/repos/o/app/releases")) return { json: state.releases ?? [] };
        throw new Error(`没料到的请求 ${method} ${url}`);
      },
    });
    const feed = (text) => ({ readFile: async () => (text ? { text } : null) });
    const output = join(temporary, "github-output");
    writeFileSync(output, "");
    const fresh = await prepareWorkflow({ env: env({ GITHUB_OUTPUT: output }), root, github: github({}), publicGithub: feed(null) });
    assert.deepEqual(fresh, { version: "0.1.0", source, runId: "77", publish: true });
    assert.equal(readFileSync(output, "utf8"), "restore=false\nartifact_id=\n");
    const kept = { name: recoveryName("77"), id: 9, expired: false };
    writeFileSync(output, "");
    await prepareWorkflow({ env: env({ GITHUB_OUTPUT: output }), root, github: github({ artifacts: [kept] }), publicGithub: feed(feedText("0.1.0", source)) });
    assert.equal(readFileSync(output, "utf8"), "restore=true\nartifact_id=9\n", "重跑沿用这次运行保存的原包（清单已是这一版也行：补收尾）");
    await assert.rejects(prepareWorkflow({ env: env(), root, github: github({ artifacts: [{ ...kept, expired: true }] }), publicGithub: feed(null) }), /过期/);
    await assert.rejects(prepareWorkflow({ env: env(), root, github: github({}), publicGithub: feed(feedText("0.1.0", source)) }), /补收尾请重跑/);
    await assert.rejects(prepareWorkflow({ env: env({ GITHUB_RUN_ATTEMPT: "2" }), root, github: github({ releases: [{ tag_name: "navi-win-v0.1.0" }] }), publicGithub: feed(null) }), /停止重封/);
    await assert.rejects(prepareWorkflow({ env: env(), root, github: github({ title: "win 0.1.0 x build" }), publicGithub: feed(null) }), /工作流名称/);
    await assert.rejects(prepareWorkflow({ env: env({ NAVI_WIN_VERSION: "0.2.0" }), root, github: github({}), publicGithub: feed(null) }), /源码里的版本/);
    await assert.rejects(prepareWorkflow({ env: env({ GITHUB_REPOSITORY: "x/y" }), root, github: github({}), publicGithub: feed(null) }), /工作流仓库/);
    const build = await prepareWorkflow({ env: env({ NAVI_WIN_PUBLISH: "false", GITHUB_RUN_ID: "78" }), root,
      github: { call: async (method, url) => (url.endsWith("/artifacts?per_page=100") ? { json: { artifacts: [] } } : { json: { event: "workflow_dispatch", head_branch: "main", display_title: runName("0.1.0", source, false) } }) },
      publicGithub: { readFile: async () => { throw new Error("只构建时不该去读清单"); } } });
    assert.equal(build.publish, false);
    console.log("✓ 只认 main 上的 workflow_dispatch；源码版本、运行名、仓库对得上才往下；原包过期、无原包补收尾、无原包重封都拒绝");
  }

  // ── 原包 ──────────────────────────────────────────────────────────────
  {
    const out = join(root, "desktop/windows/build");
    mkdirSync(join(out, "Navi", "runtime"), { recursive: true });
    writeFileSync(join(out, "Navi-0.1.0-x64-setup.exe"), "MZ the original installer");
    writeFileSync(join(out, "Navi", "runtime", ".runtime.json"), JSON.stringify({ format: 2, id: "e".repeat(64) }));
    const directory = join(temporary, "bundle");
    const request = { version: "0.1.0", source, runId: "77", publish: true };
    const manifest = buildBundle(directory, request, { root, build: false });
    assert.equal(manifest.sha256, createHash("sha256").update("MZ the original installer").digest("hex"));
    assert.equal(manifest.runtime, "e".repeat(64));
    assert.throws(() => buildBundle(directory, request, { root, build: false }), /不能覆盖/);
    assert.equal(verifyBundle(directory, request).manifest.size, statSync(join(out, "Navi-0.1.0-x64-setup.exe")).size);
    assert.throws(() => verifyBundle(directory, { ...request, runId: "78" }), /runId/);
    writeFileSync(join(directory, "payload", "Navi-0.1.0-x64-setup.exe"), "MZ the original installeR");
    assert.throws(() => verifyBundle(directory, request), /原包不同/);
    assert.throws(() => buildBundle(join(temporary, "bundle-2"), { ...request, source: "f".repeat(40) }, { root, build: false }), /未检出/);
    console.log("✓ 原包：清单记下版本、提交、运行号、sha256、大小与运行时 id；重封、换运行号、改一个字节都拒");
  }

  // ── 私钥 ──────────────────────────────────────────────────────────────
  {
    const runner = join(temporary, "runner-signing");
    mkdirSync(runner, { recursive: true });
    const secret = "qmEowTREgXY+e/AalqZkEISl/ii8GuSd0B3U5b34z+M=";
    const seen = withSigningKey({ GH_TOKEN: "t", MAC_SPARKLE_PRIVATE_KEY: `${secret}\n`, RUNNER_TEMP: runner, OTHER: "1" }, (key, childEnv) => {
      assert.equal(readFileSync(key, "utf8"), secret);
      if (process.platform !== "win32") assert.equal(statSync(key).mode & 0o777, 0o600);
      assert.equal(childEnv.MAC_SPARKLE_PRIVATE_KEY, undefined, "子进程环境里没有私钥");
      assert.equal(childEnv.OTHER, "1");
      return key;
    });
    assert.ok(!existsSync(seen), "用完即删");
    assert.throws(() => withSigningKey({ GH_TOKEN: "t", MAC_SPARKLE_PRIVATE_KEY: secret, RUNNER_TEMP: runner }, (key) => { throw new Error(`boom ${existsSync(key)}`); }), /boom true/);
    assert.ok(!existsSync(join(runner, "navi-win-signing")), "失败也删");
    assert.throws(() => withSigningKey({ GH_TOKEN: "t", RUNNER_TEMP: runner }, () => {}), /MAC_SPARKLE_PRIVATE_KEY/);
    assert.throws(() => withSigningKey({ MAC_SPARKLE_PRIVATE_KEY: secret, RUNNER_TEMP: runner }, () => {}), /MAC_RELEASE_TOKEN/);
    assert.throws(() => publishBundle(join(temporary, "bundle"), { version: "0.1.0", source, runId: "77", publish: false }), /演练不执行公开发布/);
    console.log("✓ 私钥（与 mac 共用的 Secret）落成 0600 临时文件、子进程环境里没有它、成功失败都删；缺 Secret 直接停；publish=false 不发布");
  }

  // ── 工作流文件（build-win 那一段）──────────────────────────────────────
  {
    const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const build = yml.slice(yml.indexOf("\n  build-win:\n"), yml.indexOf("\n  publish:\n"));
    assert.ok(build, "Windows 有自己的构建 job");
    assert.match(build, /runs-on: windows-latest/);
    assert.match(build, /github\.ref == 'refs\/heads\/main'/, "只在 main 上跑");
    assert.deepEqual([...new Set(build.match(/secrets\.\w+/g))].sort(), ["secrets.MAC_RELEASE_TOKEN", "secrets.MAC_SPARKLE_PRIVATE_KEY"]);
    assert.match(build, /RELEASE_READY: \$\{\{ secrets\.MAC_RELEASE_TOKEN != '' && secrets\.MAC_SPARKLE_PRIVATE_KEY != '' \}\}/, "构建一步只看 Secret 配没配，拿不到它的值");
    assert.ok(build.indexOf("smoke-installer.mjs") > build.indexOf("cloud-workflow.mjs build"), "构建后先冒烟");
    assert.ok(build.indexOf("upload-artifact") > build.indexOf("smoke-installer.mjs"), "冒烟过了才存原包");
    assert.match(build, /name: win-release-\$\{\{ github\.run_id \}\}/, "原包按运行号存，合并发布那一步按它取");
    assert.equal(runName("0.1.0", "abc", true), "release 0.1.0 abc publish", "运行名和 mac 共用一份");
    console.log("✓ 工作流 build-win：windows-latest、只在 main、拿不到 Secret 的值；冒烟过了才存原包；运行名与 mac 共用");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
