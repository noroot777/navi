// Windows 云端发版（.github/workflows/release-win.yml、desktop/windows/scripts/cloud-workflow.mjs、cloud-release.mjs，在 mac 上也跑）：
//   · 工作流只认 main 上的 workflow_dispatch；源码提交在 main 上、源码版本号就是参数那一版、运行名对得上参数；
//     重跑沿用这次运行保存的原包，原包过期、清单已是这一版又没有原包、重跑时已有 Release 又没有原包，都拒绝
//   · 原包：清单（版本、提交、运行号、sha256、大小、运行时 id）与安装包一一对得上，改了一个字节就拒
//   · 私钥：落成 0600 的临时文件、子进程环境里没有它、失败也删；publish=false 不发布
//   · 工作流文件：action 钉 sha、构建一步拿不到发布 Secret、原包先存再发布、两步都在 windows-latest 上
//   · `npm run release:win`：干净的 main 才改版本、只提交版本那一行、推送后按提交触发；同一提交已有任务就沿用，
//     失败的重跑它；远端领先、倒退版本、同一版换了提交都不动
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCloud } from "../desktop/windows/scripts/cloud-release.mjs";
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

  // ── 工作流文件 ────────────────────────────────────────────────────────
  {
    const yml = readFileSync(new URL("../.github/workflows/release-win.yml", import.meta.url), "utf8");
    const jobs = yml.split(/^  (?=build:|publish:)/m);
    const [build, publish] = [jobs.find((part) => part.startsWith("build:")), jobs.find((part) => part.startsWith("publish:"))];
    assert.ok(build && publish, "构建和发布是两个 job");
    for (const line of yml.match(/uses: \S+/g)) assert.match(line, /@[0-9a-f]{40}$/, `action 要钉 sha：${line}`);
    assert.match(yml, /workflow_dispatch:/);
    assert.doesNotMatch(yml, /^\s+(push|pull_request|schedule):/m, "只能手动触发");
    for (const job of [build, publish]) {
      assert.match(job, /runs-on: windows-latest/);
      assert.match(job, /github\.ref == 'refs\/heads\/main'/, "只在 main 上跑");
    }
    assert.match(publish, /needs: build/);
    assert.match(publish, /if: inputs\.publish/);
    assert.deepEqual([...new Set(build.match(/secrets\.\w+/g))].sort(), ["secrets.MAC_RELEASE_TOKEN", "secrets.MAC_SPARKLE_PRIVATE_KEY"]);
    assert.match(build, /RELEASE_READY: \$\{\{ secrets\.MAC_RELEASE_TOKEN != '' && secrets\.MAC_SPARKLE_PRIVATE_KEY != '' \}\}/, "构建一步只看 Secret 配没配，拿不到它的值");
    const signStep = publish.slice(publish.indexOf("cloud-workflow.mjs publish"));
    assert.match(signStep, /MAC_SPARKLE_PRIVATE_KEY: \$\{\{ secrets\.MAC_SPARKLE_PRIVATE_KEY \}\}/);
    assert.equal((publish.match(/secrets\.MAC_SPARKLE_PRIVATE_KEY/g) ?? []).length, 1, "私钥只给签名发布那一步");
    assert.doesNotMatch(publish, /tauri-cli|cargo/, "签名用 node，发布那一步不装 tauri-cli");
    assert.ok(build.indexOf("smoke-installer.mjs") > build.indexOf("cloud-workflow.mjs build"), "构建后先冒烟");
    assert.ok(build.indexOf("upload-artifact") > build.indexOf("smoke-installer.mjs"), "冒烟过了才存原包");
    assert.match(publish, /Require original installer[\s\S]*test "\$RESTORE" = true/, "发布只用存下来的原包");
    assert.match(publish, /if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/navi-win-signing"/);
    assert.match(yml, /run-name: win \$\{\{ inputs\.version \}\} \$\{\{ inputs\.source_sha \}\} \$\{\{ inputs\.publish && 'publish' \|\| 'build' \}\}/);
    assert.equal(runName("0.1.0", "abc", true), "win 0.1.0 abc publish");
    console.log("✓ 工作流：手动触发、只在 main、action 钉 sha；构建一步拿不到 Secret 的值；冒烟过了才存原包；私钥只给签名发布那一步、用完删");
  }

  // ── npm run release:win ───────────────────────────────────────────────
  {
    const fixture = (name) => {
      const dir = repo(name);
      const bare = join(temporary, `${name}.git`);
      git(temporary, "init", "--bare", "-q", bare);
      git(dir, "config", `url.file://${bare}.insteadOf`, "https://github.com/o/app.git");
      git(dir, "remote", "add", "origin", "https://github.com/o/app.git");
      git(dir, "push", "-q", "origin", "main");
      return { dir, bare };
    };
    const fakeGithub = (state = {}) => {
      state.runs ??= [];
      state.calls = [];
      return {
        state,
        async call(method, url, { body } = {}) {
          state.calls.push(`${method} ${url.replace(/\?.*$/, "")}`);
          if (url === "/repos/o/app") return { json: { default_branch: "main" } };
          if (url === "/repos/o/app/actions/workflows/release-win.yml") return { json: { state: "active" } };
          if (url.startsWith("/repos/o/app/actions/workflows/release-win.yml/runs")) return { json: { workflow_runs: state.runs } };
          if (url.endsWith("/dispatches")) {
            assert.deepEqual(Object.keys(body.inputs).sort(), ["publish", "source_sha", "version"]);
            state.runs.unshift({ id: 5, display_title: runName(body.inputs.version, body.inputs.source_sha), status: "queued", html_url: "https://run/5" });
            return { json: { html_url: "https://run/5" } };
          }
          if (url.endsWith("/rerun")) return { json: {} };
          throw new Error(`没料到的请求 ${method} ${url}`);
        },
        readFile: async () => (state.feed ? { text: state.feed } : null),
      };
    };
    const quiet = { say: () => {} };

    const { dir, bare } = fixture("cloud");
    const github = fakeGithub();
    await releaseCloud("0.2.0", { cwd: dir, github, ...quiet });
    const head = git(dir, "rev-parse", "HEAD");
    assert.equal(git(dir, "log", "-1", "--format=%s"), "chore(win): 版本号 0.2.0");
    assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n"), ["desktop/windows/shell/tauri.conf.json"], "只提交版本那一行");
    assert.equal(readFileSync(join(dir, "desktop/windows/shell/tauri.conf.json"), "utf8"), conf("0.2.0"));
    assert.equal(git(bare, "rev-parse", "main"), head, "推上去的就是版本提交");
    assert.ok(github.state.calls.includes("POST /repos/o/app/actions/workflows/release-win.yml/dispatches"));

    // 同一提交已有任务：沿用；失败的重跑
    github.state.runs[0].status = "completed";
    github.state.runs[0].conclusion = "failure";
    await releaseCloud("0.2.0", { cwd: dir, github, ...quiet });
    assert.ok(github.state.calls.includes("POST /repos/o/app/actions/runs/5/rerun"));
    assert.equal(github.state.calls.filter((call) => call.endsWith("/dispatches")).length, 1, "不重复触发");
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "不再建版本提交");

    // 工作区不干净 / 不在 main / 倒退 / 清单已是更新的 / 同一版换了提交 / 远端领先：都不动
    writeFileSync(join(dir, "business.txt"), "dirty\n");
    await assert.rejects(releaseCloud("0.3.0", { cwd: dir, github: fakeGithub(), ...quiet }), /没提交的改动/);
    git(dir, "checkout", "-q", "--", "business.txt");
    await assert.rejects(releaseCloud("0.1.0", { cwd: dir, github: fakeGithub(), ...quiet }), /倒退/);
    await assert.rejects(releaseCloud("0.3.0", { cwd: dir, github: fakeGithub({ feed: feedText("0.4.0", head) }), ...quiet }), /更旧/);
    await assert.rejects(releaseCloud("0.2.0", { cwd: dir, github: fakeGithub({ feed: feedText("0.2.0", "b".repeat(40)) }), ...quiet }), /另一个提交.*没有修改版本或推送/);
    const other = join(temporary, "other");
    git(temporary, "clone", "-q", bare, other);
    git(other, "config", "user.name", "x");
    git(other, "config", "user.email", "x@example.invalid");
    writeFileSync(join(other, "business.txt"), "remote change\n");
    git(other, "commit", "-q", "-am", "remote");
    git(other, "push", "-q", "origin", "main");
    await assert.rejects(releaseCloud("0.3.0", { cwd: dir, github: fakeGithub(), ...quiet }), /远端 main 有本地尚未包含的提交/);
    assert.equal(git(dir, "rev-parse", "HEAD"), head, "被拒时没有版本提交");
    assert.equal(git(dir, "status", "--porcelain"), "");
    git(dir, "checkout", "-q", "-b", "feature");
    await assert.rejects(releaseCloud("0.3.0", { cwd: dir, github: fakeGithub(), ...quiet }), /只从本地 main/);
    console.log("✓ release:win：只提交版本那一行、推送后按提交触发；同提交沿用（失败的重跑）；不干净、倒退、清单更新、换提交、远端领先、不在 main 都不动");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
