// `npm run release`（desktop/release.mjs → desktop/shared/cloud-release.mjs）：mac 和 Windows 一起发同一个版本号。
//   · 两边的版本号进同一个提交、推一次，两条工作流用同一个 SHA 触发
//   · 任何一边预检不过（工作流没启用、更新源已经更新）就谁都不动：没有版本提交、没有推送、哪边都不触发
//   · 推上去以后一边没触发成：另一边照样触发，报错说清是哪一边；重跑同一命令只补那一边，不再建版本提交
//   · 两边版本号已经是这一版：不建提交，照样按当前提交触发
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

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function fixture(name, { mac = "0.3.1", win = "0.1.0" } = {}) {
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
  writeFileSync(join(dir, "desktop/macos/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", appcastPath: "navi/mac/appcast.xml", tagPrefix: "navi-mac-v" }));
  writeFileSync(join(dir, WIN_FILE), `{\n  "productName": "Navi",\n  "version": "${win}",\n  "identifier": "dev.navi.win"\n}\n`);
  writeFileSync(join(dir, "desktop/windows/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", feedPath: "navi/win/latest.json", tagPrefix: "navi-win-v", publicKey: "PK" }));
  writeFileSync(join(dir, "business.txt"), "already reviewed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "initial");
  git(dir, "push", "-q", "origin", "HEAD:main");
  return { dir, bare, head: () => git(dir, "rev-parse", "HEAD"), versions: () => [macVersion(readFileSync(join(dir, MAC_FILE), "utf8")), winVersion(readFileSync(join(dir, WIN_FILE), "utf8"))] };
}

/** 两条工作流的假 GitHub：inactive / denyDispatch 按工作流名设，feeds 按路径放更新源。 */
function fakeGithub(state = {}) {
  state.runs ??= { "release-mac.yml": [], "release-win.yml": [] };
  state.inactive ??= new Set();
  state.denyDispatch ??= new Set();
  state.feeds ??= {};
  state.dispatched = [];
  let id = 0;
  return {
    state,
    async call(method, url, { body } = {}) {
      const path = url.replace(/\?.*$/, "");
      if (path === "/repos/o/app") return { json: { default_branch: "main" } };
      const runs = path.match(/^\/repos\/o\/app\/actions\/workflows\/([\w.-]+)\/runs$/);
      if (runs) return { json: { workflow_runs: state.runs[runs[1]] } };
      const dispatch = path.match(/^\/repos\/o\/app\/actions\/workflows\/([\w.-]+)\/dispatches$/);
      if (dispatch) {
        const workflow = dispatch[1];
        if (state.denyDispatch.has(workflow)) throw new Error("HTTP 403 Actions write denied");
        const prefix = workflow === "release-mac.yml" ? "mac" : "win";
        const run = { id: ++id, display_title: `${prefix} ${body.inputs.version} ${body.inputs.source_sha} publish`, status: "queued", html_url: `https://run/${workflow}/${id}` };
        state.runs[workflow].unshift(run);
        state.dispatched.push([workflow, body.inputs.version, body.inputs.source_sha]);
        return { json: { html_url: run.html_url } };
      }
      const workflow = path.match(/^\/repos\/o\/app\/actions\/workflows\/([\w.-]+)$/);
      if (workflow) return { json: { state: state.inactive.has(workflow[1]) ? "disabled_manually" : "active" } };
      throw new Error(`没料到的请求 ${method} ${url}`);
    },
    readFile: async (repo, path) => (state.feeds[path] ? { text: state.feeds[path] } : null),
  };
}

const quiet = { say: () => {} };

try {
  // 一起发：同一个提交改两边的版本号、推一次、同一个 SHA 触发两条
  {
    const item = fixture("happy");
    const github = fakeGithub();
    await releaseAll("0.3.2", { cwd: item.dir, github, ...quiet });
    const head = item.head();
    assert.equal(git(item.dir, "log", "-1", "--format=%s"), "chore(release): 版本号 0.3.2（mac、win）");
    assert.deepEqual(git(item.dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [MAC_FILE, WIN_FILE].sort(), "只提交两个版本文件");
    assert.deepEqual(item.versions(), ["0.3.2", "0.3.2"]);
    assert.equal(git(item.bare, "rev-parse", "main"), head, "推上去的就是版本提交");
    assert.deepEqual(github.state.dispatched, [["release-mac.yml", "0.3.2", head], ["release-win.yml", "0.3.2", head]]);
    await releaseAll("0.3.2", { cwd: item.dir, github, ...quiet });
    assert.equal(github.state.dispatched.length, 2, "同一提交已有任务就沿用，不重复触发");
    assert.equal(item.head(), head);
    console.log("✓ 一起发：两边版本号进同一个提交、推一次、同一个 SHA 触发两条；再执行沿用已有任务");
  }

  // 预检：哪一边不过都谁都不动
  {
    const item = fixture("preflight");
    const initial = item.head();
    const inactive = fakeGithub({ inactive: new Set(["release-win.yml"]) });
    await assert.rejects(releaseAll("0.3.2", { cwd: item.dir, github: inactive, ...quiet }), /Windows 发布工作流未启用/);
    const newer = fakeGithub({ feeds: { "navi/win/latest.json": renderFeed({ version: "0.4.0", notes: "", url: "u", signature: "s", commit: "c".repeat(40), sha256: "d".repeat(64), size: 1 }) } });
    await assert.rejects(releaseAll("0.3.2", { cwd: item.dir, github: newer, ...quiet }), /更新清单已经是 0\.4\.0/);
    await assert.rejects(releaseAll("0.3.0", { cwd: item.dir, github: fakeGithub(), ...quiet }), /不能把 Mac 的源码版本从 0\.3\.1 倒退/);
    assert.equal(item.head(), initial, "没有版本提交");
    assert.equal(git(item.bare, "rev-parse", "main"), initial, "没有推送");
    assert.deepEqual([...inactive.state.dispatched, ...newer.state.dispatched], [], "哪边都没触发");
    assert.deepEqual(item.versions(), ["0.3.1", "0.1.0"]);
    console.log("✓ 预检：一边工作流没启用、更新源已更新、版本倒退，都没有版本提交、没有推送、哪边都不触发");
  }

  // 推上去以后一边没触发成：另一边照样触发；重跑只补那一边
  {
    const item = fixture("partial");
    const github = fakeGithub({ denyDispatch: new Set(["release-win.yml"]) });
    await assert.rejects(releaseAll("0.3.2", { cwd: item.dir, github, ...quiet }), /代码已推送[\s\S]*Windows：HTTP 403[\s\S]*重新执行同一命令/);
    const head = item.head();
    assert.deepEqual(github.state.dispatched, [["release-mac.yml", "0.3.2", head]], "mac 照样触发");
    github.state.denyDispatch.clear();
    await releaseAll("0.3.2", { cwd: item.dir, github, ...quiet });
    assert.equal(item.head(), head, "不再建版本提交");
    assert.deepEqual(github.state.dispatched, [["release-mac.yml", "0.3.2", head], ["release-win.yml", "0.3.2", head]], "只补 Windows");
    console.log("✓ 一边没触发成：另一边照样触发、报错说清是哪一边；重跑只补那一边，不再建版本提交");
  }

  // 两边已经是这一版：不建提交，按当前提交触发；只有一边要改时提交按那一边命名
  {
    const same = fixture("same", { mac: "0.3.2", win: "0.3.2" });
    const initial = same.head();
    const github = fakeGithub();
    await releaseAll("0.3.2", { cwd: same.dir, github, ...quiet });
    assert.equal(same.head(), initial);
    assert.deepEqual(github.state.dispatched.map(([, , sha]) => sha), [initial, initial]);
    const one = fixture("one", { mac: "0.3.2", win: "0.1.0" });
    await releaseAll("0.3.2", { cwd: one.dir, github: fakeGithub(), ...quiet });
    assert.equal(git(one.dir, "log", "-1", "--format=%s"), "chore(win): 版本号 0.3.2");
    assert.deepEqual(git(one.dir, "show", "--name-only", "--format=", "HEAD").split("\n"), [WIN_FILE]);
    console.log("✓ 版本号已对齐就不建提交、按当前提交触发；只有一边要改时只提交那一边");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
