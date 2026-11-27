// `npm run release`（desktop/release.mjs → desktop/shared/cloud-release.mjs）：mac 和 Windows 一起发同一个版本号，触发一条 release.yml。
//   · 两边的版本号进同一个提交、推一次，按这个提交触发一次 release.yml；同一提交已有任务就沿用（失败的重跑），成功的不再触发
//   · 动版本号之前所有判断都做完：工作区、分支、倒退、工作流、Actions 读权限、两边更新源、远端领先 —— 不过就什么都不动
//   · 这一版只在一部分平台（或 Mac 一部分架构）发过、又没有原工作流：推之前就拒，不建提交、不推、不触发
//   · 预检期间本地 main 多了提交：停，不把没核对过的提交发出去
//   · 触发失败：代码已推送，重跑同一命令不再建版本提交；推送被拒保留版本提交；提交被钩子拒只撤回版本号
//   · 两边都已发过这一版：什么都不做
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseAll } from "../desktop/release.mjs";
import { sourceVersion as macVersion } from "../desktop/macos/scripts/release-state.mjs";
import { renderFeed, sourceVersion as winVersion } from "../desktop/windows/scripts/release-state.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-release-all-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const MAC_FILE = "desktop/macos/build.sh";
const WIN_FILE = "desktop/windows/shell/tauri.conf.json";
const ARM_FEED = "navi/mac/appcast.xml";
const INTEL_FEED = "navi/mac/appcast-intel.xml";
const WIN_FEED = "navi/win/latest.json";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function fixture(name, { mac = "0.3.5", win = "0.1.0" } = {}) {
  const dir = join(temporary, name);
  const bare = join(temporary, `${name}.git`);
  mkdirSync(join(dir, "desktop/macos"), { recursive: true });
  mkdirSync(join(dir, "desktop/windows/shell"), { recursive: true });
  git(temporary, "init", "--bare", "-q", bare);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "release test");
  git(dir, "config", "user.email", "release@example.invalid");
  git(dir, "config", "core.hooksPath", "/dev/null");
  git(dir, "config", `url.file://${bare}.insteadOf`, "https://github.com/o/app.git");
  git(dir, "remote", "add", "origin", "https://github.com/o/app.git");
  writeFileSync(join(dir, MAC_FILE), `#!/bin/bash\nVERSION="${mac}"\n`);
  writeFileSync(join(dir, "desktop/macos/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", appcastPath: ARM_FEED, tagPrefix: "v",
    architectures: { x64: { appcastPath: INTEL_FEED, legacyAppcastPath: null } } }));
  writeFileSync(join(dir, WIN_FILE), `{\n  "productName": "Navi",\n  "version": "${win}",\n  "identifier": "dev.navi.win"\n}\n`);
  writeFileSync(join(dir, "desktop/windows/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", feedPath: WIN_FEED, tagPrefix: "v", publicKey: "PK" }));
  writeFileSync(join(dir, "business.txt"), "already reviewed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "initial");
  git(dir, "push", "-q", "origin", "HEAD:main");
  return {
    dir, bare,
    head: () => git(dir, "rev-parse", "HEAD"),
    remote: () => git(bare, "rev-parse", "main"),
    versions: () => [macVersion(readFileSync(join(dir, MAC_FILE), "utf8")), winVersion(readFileSync(join(dir, WIN_FILE), "utf8"))],
  };
}

const appcast = (shortVersion, commit) => `<rss><channel><item><sparkle:version>20261121.010203</sparkle:version><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><navi:commit>${commit}</navi:commit></item></channel></rss>`;
const latest = (version, commit) => renderFeed({ version, notes: "", url: `https://x/Navi-${version}-x64-setup.exe`, signature: "S", commit, sha256: "0".repeat(64), size: 1 });

/** release.yml 一条工作流的假 GitHub。onRead 在读更新源时调（模拟预检期间别处改了仓库）。 */
function fakeGithub(state = {}) {
  state.runs ??= [];
  state.feeds ??= {};
  state.calls = [];
  state.dispatched = [];
  return {
    state,
    async call(method, url, { body } = {}) {
      const path = url.replace(/\?.*$/, "");
      state.calls.push(`${method} ${path}`);
      if (path === "/repos/o/app") return { json: { default_branch: "main" } };
      if (path === "/repos/o/app/actions/workflows/release.yml") return { json: { state: state.inactive ? "disabled_manually" : "active" } };
      if (path === "/repos/o/app/actions/workflows/release.yml/runs") {
        if (state.denyRuns) throw new Error("HTTP 403 Resource not accessible");
        const page = Number(new URL(url, "http://x").searchParams.get("page") ?? 1);
        return { json: { workflow_runs: state.runs.slice((page - 1) * 100, page * 100) } };
      }
      if (path === "/repos/o/app/actions/workflows/release.yml/dispatches") {
        assert.deepEqual(Object.keys(body.inputs).sort(), ["publish", "source_sha", "version"]);
        assert.equal(body.inputs.publish, "true");
        if (state.denyDispatch) throw new Error("HTTP 403 Actions write denied");
        const id = state.dispatched.length + 1;
        state.runs.unshift({ id, display_title: `release ${body.inputs.version} ${body.inputs.source_sha} publish`, status: "queued", conclusion: null, html_url: `https://run/${id}` });
        state.dispatched.push([body.inputs.version, body.inputs.source_sha]);
        return { json: { html_url: `https://run/${id}` } };
      }
      const rerun = path.match(/^\/repos\/o\/app\/actions\/runs\/(\d+)\/rerun$/);
      if (rerun) {
        state.runs.find((run) => run.id === Number(rerun[1])).status = "queued";
        return { json: {} };
      }
      throw new Error(`没料到的请求 ${method} ${url}`);
    },
    async readFile(repo, path) {
      state.onRead?.(path);
      return state.feeds[path] ? { text: state.feeds[path] } : null;
    },
  };
}

const quiet = { say: () => {} };
const untouched = (item, before, github, message, dirty = "") => {
  assert.equal(item.head(), before, `${message}：没有版本提交`);
  assert.equal(item.remote(), before, `${message}：没有推送`);
  assert.deepEqual(github.state.dispatched, [], `${message}：没有触发`);
  assert.equal(git(item.dir, "status", "--porcelain"), dirty, `${message}：版本号没动`);
};

try {
  // ── 预检：哪一样不过都什么都不动 ───────────────────────────────────────
  {
    const item = fixture("preflight");
    const before = item.head();
    const run = (version, state, pattern, message, dirty) => {
      const github = fakeGithub(state);
      return assert.rejects(releaseAll(version, { cwd: item.dir, github, ...quiet }), pattern, message).then(() => untouched(item, before, github, message, dirty));
    };
    writeFileSync(join(item.dir, "uncommitted.txt"), "not for release");
    await run("0.3.6", {}, /没提交的改动/, "工作区不干净", "?? uncommitted.txt");
    rmSync(join(item.dir, "uncommitted.txt"));
    git(item.dir, "switch", "-qc", "feature");
    await run("0.3.6", {}, /本地 main/, "不在 main");
    git(item.dir, "switch", "-q", "main");
    await run("0.3.4", {}, /不能把 Mac 的源码版本从 0\.3\.5 倒退/, "版本倒退");
    await run("0.3.6", { inactive: true }, /release\.yml 未启用/, "工作流没启用");
    await run("0.3.6", { denyRuns: true }, /HTTP 403/, "读不了 Actions");
    await run("0.3.6", { feeds: { [INTEL_FEED]: appcast("0.3.7", before) } }, /Mac 更新源已经是 0\.3\.7/, "Intel 更新源更新");
    await run("0.3.6", { feeds: { [WIN_FEED]: latest("0.4.0", before) } }, /Windows 更新清单已经是 0\.4\.0/, "Windows 更新清单更新");
    await run("0.3.5", { feeds: { [ARM_FEED]: appcast("0.3.5", "f".repeat(40)), [INTEL_FEED]: appcast("0.3.5", "f".repeat(40)) } }, /已从另一个提交发布/, "同一版换了提交");
    const other = join(temporary, "other");
    git(temporary, "clone", "-q", item.bare, other);
    git(other, "config", "user.name", "x");
    git(other, "config", "user.email", "x@example.invalid");
    writeFileSync(join(other, "business.txt"), "remote change\n");
    git(other, "commit", "-q", "-am", "remote");
    git(other, "push", "-q", "origin", "main");
    const github = fakeGithub();
    await assert.rejects(releaseAll("0.3.6", { cwd: item.dir, github, ...quiet }), /远端 main 有本地尚未包含的提交/);
    assert.equal(item.head(), before);
    assert.deepEqual(github.state.dispatched, []);
    console.log("✓ 预检：不干净、不在 main、倒退、工作流没启用、读不了 Actions、两边更新源更新、同版换提交、远端领先，都不建提交、不推、不触发");
  }

  // ── 只发了一部分：推之前就拒 ──────────────────────────────────────────
  {
    const item = fixture("partial", { mac: "0.3.5", win: "0.1.0" });
    const before = item.head();
    const macOnly = fakeGithub({ feeds: { [ARM_FEED]: appcast("0.3.5", before), [INTEL_FEED]: appcast("0.3.5", before) } });
    await assert.rejects(releaseAll("0.3.5", { cwd: item.dir, github: macOnly, ...quiet }), /只有 Mac 发过[\s\S]*改用新的版本号/);
    untouched(item, before, macOnly, "只有 Mac 发过");
    const aligned = fixture("partial-arch", { mac: "0.3.5", win: "0.3.5" });
    const alignedHead = aligned.head();
    const oneArch = fakeGithub({ feeds: { [ARM_FEED]: appcast("0.3.5", alignedHead) } });
    await assert.rejects(releaseAll("0.3.5", { cwd: aligned.dir, github: oneArch, ...quiet }), /Mac 只有部分架构已经发布/);
    untouched(aligned, alignedHead, oneArch, "Mac 只发了一个架构");
    const done = fakeGithub({ feeds: { [ARM_FEED]: appcast("0.3.5", alignedHead), [INTEL_FEED]: appcast("0.3.5", alignedHead), [WIN_FEED]: latest("0.3.5", alignedHead) } });
    assert.equal(await releaseAll("0.3.5", { cwd: aligned.dir, github: done, ...quiet }), null, "三份都发过了：什么都不做");
    untouched(aligned, alignedHead, done, "都发过了");
    console.log("✓ 只发了一部分（只有 Mac、Mac 只有一个架构）又没有原工作流：推之前就拒；都发过了什么都不做");
  }

  // ── 预检期间 main 上多了提交：停 ────────────────────────────────────────
  {
    const item = fixture("moved");
    const before = item.head();
    const github = fakeGithub({
      onRead(path) {
        if (path !== WIN_FEED) return;
        writeFileSync(join(item.dir, "business.txt"), "sneaked in\n");
        git(item.dir, "commit", "-qam", "sneaked in during preflight");
      },
    });
    await assert.rejects(releaseAll("0.3.6", { cwd: item.dir, github, ...quiet }), /预检期间本地 main 或工作区被别处改动了/);
    assert.equal(item.remote(), before, "插进来的提交没被推上去");
    assert.deepEqual(github.state.dispatched, []);
    assert.deepEqual(item.versions(), ["0.3.5", "0.1.0"]);
    console.log("✓ 预检期间本地 main 多了提交：停，不推、不触发，只发开始时核对过的那个提交");
  }

  // ── 一起发：一个提交、推一次、触发一次；沿用、重跑、不重复 ─────────────────
  {
    const item = fixture("happy");
    writeFileSync(join(item.dir, "business.txt"), "a reviewed local commit\n");
    git(item.dir, "commit", "-qam", "reviewed development");
    const github = fakeGithub();
    const run = await releaseAll("0.3.6", { cwd: item.dir, github, ...quiet });
    const head = item.head();
    assert.equal(git(item.dir, "log", "-1", "--format=%s"), "chore(release): 版本号 0.3.6（mac、win）");
    assert.deepEqual(git(item.dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [MAC_FILE, WIN_FILE].sort(), "只提交两个版本文件");
    assert.deepEqual(item.versions(), ["0.3.6", "0.3.6"], "Windows 的版本号跟 mac 对齐");
    assert.equal(item.remote(), head, "推上去的就是版本提交");
    assert.deepEqual(github.state.dispatched, [["0.3.6", head]], "一个版本只触发一次 release.yml");
    assert.equal(run.html_url, "https://run/1");
    await releaseAll("0.3.6", { cwd: item.dir, github, ...quiet });
    assert.equal(github.state.dispatched.length, 1, "在跑的任务沿用");
    github.state.runs[0].status = "completed";
    github.state.runs[0].conclusion = "failure";
    await releaseAll("0.3.6", { cwd: item.dir, github, ...quiet });
    assert.ok(github.state.calls.includes("POST /repos/o/app/actions/runs/1/rerun"), "失败的重跑原任务（沿用存下的原包）");
    github.state.runs[0].conclusion = "success";
    github.state.runs.unshift(...Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, display_title: `unrelated ${index}` })));
    await releaseAll("0.3.6", { cwd: item.dir, github, ...quiet });
    assert.equal(github.state.dispatched.length, 1, "成功过的不再触发（翻页也找得到）");
    assert.equal(item.head(), head, "都没有再建版本提交");
    console.log("✓ 一起发：两边版本号进一个提交、推一次、触发一次 release.yml；在跑的沿用、失败的重跑、成功的不再触发");
  }

  // ── 推上去以后的失败 ──────────────────────────────────────────────────
  {
    const item = fixture("dispatch");
    const github = fakeGithub({ denyDispatch: true });
    await assert.rejects(releaseAll("0.3.6", { cwd: item.dir, github, ...quiet }), /代码已推送[\s\S]*Actions write denied[\s\S]*重新执行同一命令/);
    const head = item.head();
    assert.equal(item.remote(), head);
    github.state.denyDispatch = false;
    await releaseAll("0.3.6", { cwd: item.dir, github, ...quiet });
    assert.equal(item.head(), head, "重跑不再建版本提交");
    assert.deepEqual(github.state.dispatched, [["0.3.6", head]]);

    const rejected = fixture("rejected");
    writeFileSync(join(rejected.bare, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const pushDenied = fakeGithub();
    await assert.rejects(releaseAll("0.3.6", { cwd: rejected.dir, github: pushDenied, ...quiet }), /git push 失败/);
    assert.deepEqual(rejected.versions(), ["0.3.6", "0.3.6"], "推送被拒：本地版本提交保留");
    assert.deepEqual(pushDenied.state.dispatched, []);

    const hooks = fixture("hooks");
    mkdirSync(join(hooks.dir, "hooks"));
    writeFileSync(join(hooks.dir, "hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(hooks.dir, "config", "core.hooksPath", "hooks");
    git(hooks.dir, "add", "hooks");
    git(hooks.dir, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "add failing hook");
    await assert.rejects(releaseAll("0.3.6", { cwd: hooks.dir, github: fakeGithub(), ...quiet }), /git commit 失败/);
    assert.deepEqual(hooks.versions(), ["0.3.5", "0.1.0"], "提交被拒：只撤回版本号");
    assert.equal(git(hooks.dir, "status", "--porcelain"), "");
    console.log("✓ 触发失败重跑不再建提交；推送被拒保留版本提交、不触发；提交被拒只撤回版本号");
  }

  // ── 版本号已经对齐 / 只有一边要改 ──────────────────────────────────────
  {
    const same = fixture("same", { mac: "0.3.6", win: "0.3.6" });
    const initial = same.head();
    const github = fakeGithub();
    await releaseAll("0.3.6", { cwd: same.dir, github, ...quiet });
    assert.equal(same.head(), initial, "不建提交");
    assert.deepEqual(github.state.dispatched, [["0.3.6", initial]]);
    const one = fixture("one", { mac: "0.3.6", win: "0.1.0" });
    await releaseAll("0.3.6", { cwd: one.dir, github: fakeGithub(), ...quiet });
    assert.equal(git(one.dir, "log", "-1", "--format=%s"), "chore(release): 版本号 0.3.6（win）");
    assert.deepEqual(git(one.dir, "show", "--name-only", "--format=", "HEAD").split("\n"), [WIN_FILE]);
    console.log("✓ 版本号已对齐就不建提交、按当前提交触发；只有一边要改时只提交那一边");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
