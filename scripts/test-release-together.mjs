// 合并发布（desktop/shared/release-together.mjs、release-publish.mjs 的 stage / finish、.github/workflows/release.yml）：
//   · 一个版本一个 Release：tag v<版本>，三个文件 Navi-<v>.dmg、Navi-<v>-intel.dmg、Navi-<v>-x64-setup.exe；mac 与 Windows 配置对不上就拒
//   · 单平台入口（single）不碰 v<版本>：上传前就拒，只有合并发布（握着三份同源原包）能公开它
//   · stage 只进草稿并下回核对、不公开；已公开的 Release 不往里补没核对过的包；finish 只认已公开的
//   · 三个包都在草稿里核对过才公开，少一个不公开、不推任何更新源；重跑接着补，不重复建草稿
//   · 公开之后各平台推自己的更新源：一个失败不挡另一个，最后一并报；tag 没打在构建提交上就一个都不推
//   · locate：三份原包都要在这次运行里存过；工作流：publish 等三个构建都过、在 macOS 上、Secret 只给发布那一步
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ReleaseStop, putOnRelease } from "../desktop/shared/release-publish.mjs";
import { PARTS, locate, publish, releasePlan } from "../desktop/shared/release-together.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-release-together-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

/** 只认 putOnRelease / publish 用到的那几样的假 GitHub：草稿没有 tag，公开时按 target 打出来。 */
function fakeGithub({ commit, tagElsewhere } = {}) {
  const state = { releases: [], tags: {}, calls: [] };
  let id = 0;
  return {
    state,
    async commitSha() { return commit; },
    async tagCommit(repo, tag) { return state.tags[tag] ?? null; },
    async findRelease(repo, tag) {
      const found = state.releases.find((release) => release.tag_name === tag);
      return found ? structuredClone(found) : null;
    },
    async createDraftRelease(repo, { tag, target, name, body }) {
      state.calls.push(`draft ${tag}`);
      const release = { id: ++id, tag_name: tag, target, name, body, draft: true, assets: [] };
      state.releases.push(release);
      return structuredClone(release);
    },
    async uploadAsset(release, file) {
      const stored = state.releases.find((entry) => entry.id === release.id);
      const existing = stored.assets.find((asset) => asset.name === basename(file));
      if (existing) return existing;
      state.calls.push(`upload ${basename(file)}`);
      const asset = { name: basename(file), size: statSync(file).size, bytes: readFileSync(file), browser_download_url: `https://dl/${release.tag_name}/${basename(file)}` };
      stored.assets.push(asset);
      return asset;
    },
    async downloadAsset(asset) { return asset.bytes; },
    async publishRelease(repo, release, target) {
      state.calls.push(`publish ${release.tag_name}`);
      const stored = state.releases.find((entry) => entry.id === release.id);
      stored.draft = false;
      state.tags[stored.tag_name] = tagElsewhere ?? target;
      return structuredClone(stored);
    },
    async readFile() { return null; },
  };
}

function file(name, body) {
  const path = join(temporary, "files", name);
  mkdirSync(join(temporary, "files"), { recursive: true });
  writeFileSync(path, body);
  return path;
}

try {
  const COMMIT = "c".repeat(40);
  const config = { releaseRepo: "o/app" };

  // ── putOnRelease 的 stage / finish ────────────────────────────────────
  {
    const github = fakeGithub({ commit: COMMIT });
    const dmg = file("Navi-0.3.6.dmg", "dmg bytes");
    const put = (path, mode) => putOnRelease(github, config, { tag: "v0.3.6", commit: COMMIT, file: path, length: statSync(path).size, name: "n", body: "b", mode });
    await assert.rejects(put(dmg, "finish"), /还没公开/, "finish 只认已公开的 Release");
    assert.deepEqual(await put(dmg, "stage").then((result) => result.staged), true);
    assert.equal(github.state.releases[0].draft, true, "stage 不公开");
    assert.deepEqual(github.state.calls, ["draft v0.3.6", "upload Navi-0.3.6.dmg"]);
    await put(dmg, "stage");
    assert.equal(github.state.calls.filter((call) => call.startsWith("upload")).length, 1, "重跑不重传");
    await assert.rejects(put(dmg, "finish"), /还没公开/);
    github.state.releases[0].draft = false;
    github.state.tags["v0.3.6"] = COMMIT;
    assert.equal((await put(dmg, "finish")).url, "https://dl/v0.3.6/Navi-0.3.6.dmg");
    await assert.rejects(put(file("Navi-0.3.6-intel.dmg", "late"), "stage"), /已经公开，上面却没有 Navi-0\.3\.6-intel\.dmg/, "不往公开的 Release 里补没核对过的包");
    console.log("✓ stage 只进草稿并核对、不公开、重跑不重传；finish 只认已公开的；已公开的 Release 不补没核对过的包");
  }

  // ── 单平台入口（single）不碰 v<版本>：只有合并发布握着三份同源原包 ───────
  {
    const github = fakeGithub({ commit: COMMIT });
    const put = (name, mode) => {
      const path = file(name, `${name} bytes`);
      return putOnRelease(github, config, { tag: "v0.3.6", commit: COMMIT, file: path, length: statSync(path).size, name: "n", body: "b", mode });
    };
    for (const name of releasePlan("0.3.6").assets) {
      await assert.rejects(put(name), /Release v0\.3\.6 是这一版 3 个包共用的，只由合并发布公开[\s\S]*什么都还没传/);
    }
    assert.deepEqual(github.state.calls, [], "上传前就拒：不建草稿、不传包、不公开");
    // 草稿里已经有合并发布 stage 过的包：single 照样不碰
    await put("Navi-0.3.6.dmg", "stage");
    await assert.rejects(put("Navi-0.3.6-intel.dmg"), /只由合并发布公开/);
    assert.deepEqual(github.state.calls, ["draft v0.3.6", "upload Navi-0.3.6.dmg"]);

    // 草稿里留着别处（坏的、别的提交的）同名包：合并发布 stage 时逐个下回比对本次原包，对不上就停、不公开
    const stale = fakeGithub({ commit: COMMIT });
    const mine = file("Navi-0.3.8.dmg", "good bytes");
    stale.state.releases.push({ id: 7, tag_name: "v0.3.8", draft: true, assets: [
      { name: "Navi-0.3.8.dmg", size: statSync(mine).size, bytes: Buffer.from("evil bytes") }] });
    await assert.rejects(putOnRelease(stale, config, { tag: "v0.3.8", commit: COMMIT, file: mine, length: statSync(mine).size, mode: "stage" }), /和本地这份不一样/);
    stale.state.releases[0].assets[0].size = 3;
    await assert.rejects(putOnRelease(stale, config, { tag: "v0.3.8", commit: COMMIT, file: mine, length: statSync(mine).size, mode: "stage" }), /不覆盖/);
    assert.equal(stale.state.releases[0].draft, true);

    // 先前（修之前）被单平台公开、只有一个包的版本：合并发布不往上补
    const early = fakeGithub({ commit: COMMIT });
    early.state.releases.push({ id: 9, tag_name: "v0.3.7", draft: false, assets: [] });
    early.state.tags["v0.3.7"] = COMMIT;
    const exe = file("Navi-0.3.7-x64-setup.exe", "exe");
    await assert.rejects(putOnRelease(early, config, { tag: "v0.3.7", commit: COMMIT, file: exe, length: statSync(exe).size, mode: "stage" }), /已经公开，上面却没有 Navi-0\.3\.7-x64-setup\.exe/);

    // 老的单平台 tag（navi-mac-v…）照旧一个包就公开
    const legacy = fakeGithub({ commit: COMMIT });
    const old = file("Navi-0.3.4.dmg", "old");
    assert.ok((await putOnRelease(legacy, config, { tag: "navi-mac-v0.3.4", commit: COMMIT, file: old, length: statSync(old).size })).url);
    assert.equal(legacy.state.releases[0].draft, false);
    console.log("✓ 单平台入口：v<版本> 一律上传前就拒（齐不齐都不碰）；已公开的不补；老 tag 照旧一个包就公开");
  }

  // ── 这一版的 Release：tag 与三个文件名 ─────────────────────────────────
  {
    const plan = releasePlan("0.3.6");
    assert.equal(plan.tag, "v0.3.6");
    assert.equal(plan.repo, "noroot777/navi");
    assert.deepEqual(plan.assets, ["Navi-0.3.6.dmg", "Navi-0.3.6-intel.dmg", "Navi-0.3.6-x64-setup.exe"]);
    const root = join(temporary, "mismatch");
    mkdirSync(join(root, "desktop/macos"), { recursive: true });
    mkdirSync(join(root, "desktop/windows"), { recursive: true });
    writeFileSync(join(root, "desktop/macos/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", tagPrefix: "v" }));
    writeFileSync(join(root, "desktop/windows/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", feedPath: "w/latest.json", tagPrefix: "navi-win-v" }));
    assert.throws(() => releasePlan("0.3.6", { root }), /一个版本只能有一个 Release/);
    console.log("✓ 一个版本一个 Release：tag v0.3.6，三个文件靠文件名区分；mac 与 Windows 的 tag 对不上就拒");
  }

  // ── publish：三个都在草稿里核对过才公开，公开后各推各的 ──────────────────
  {
    const root = join(temporary, "repo");
    mkdirSync(root, { recursive: true });
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.invalid");
    mkdirSync(join(root, "desktop/macos"), { recursive: true });
    mkdirSync(join(root, "desktop/windows"), { recursive: true });
    writeFileSync(join(root, "desktop/macos/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", tagPrefix: "v", appcastPath: "a.xml" }));
    writeFileSync(join(root, "desktop/windows/release.json"), JSON.stringify({ releaseRepo: "o/app", feedRepo: "o/feed", feedPath: "w/latest.json", tagPrefix: "v" }));
    git(root, "add", ".");
    git(root, "commit", "-qm", "feat: 一起发");
    const source = git(root, "rev-parse", "HEAD");
    const runner = join(temporary, "runner");
    const env = { RUNNER_TEMP: runner };
    const request = { version: "0.3.6", source, runId: "77", publish: true };
    for (const part of PARTS) {
      mkdirSync(join(runner, part.dir), { recursive: true });
      writeFileSync(join(runner, part.dir, "request.json"), JSON.stringify(request));
    }
    const files = Object.fromEntries(PARTS.map((part, index) => [part.key, file(releasePlan("0.3.6", { root }).assets[index], `bytes of ${part.key}`)]));
    const scenario = ({ tagElsewhere } = {}) => {
      const github = fakeGithub({ commit: source, tagElsewhere });
      const entry = { github, finished: [], failStage: null, skipStage: null, failFinish: null };
      entry.run = () => publish({
        env, root, github, say: () => {},
        stage: (part) => {
          if (entry.failStage === part.key) throw new ReleaseStop(`${part.label} 签名失败`);
          if (entry.skipStage === part.key) return null;
          return putOnRelease(github, { releaseRepo: "o/app" }, { tag: "v0.3.6", commit: source, file: files[part.key], length: statSync(files[part.key]).size, mode: "stage" });
        },
        finish: (part) => {
          if (entry.failFinish === part.key) throw new Error("appcast 409");
          entry.finished.push(part.key);
        },
      });
      return entry;
    };
    const published = (entry) => entry.github.state.calls.filter((call) => call.startsWith("publish")).length;

    const first = scenario();
    first.failStage = "win";
    await assert.rejects(first.run(), /Windows 签名失败/);
    const [release] = first.github.state.releases;
    assert.equal(release.name, "Navi 0.3.6", "草稿由合并发布建，标题是版本本身");
    for (const name of releasePlan("0.3.6", { root }).assets) assert.ok(release.body.includes(name), `说明里列出 ${name}`);
    assert.ok(release.body.includes("feat: 一起发"), "说明里有这一版的提交");
    assert.equal(release.draft, true, "一个包没进草稿：不公开");
    assert.equal(published(first), 0);
    assert.deepEqual(first.finished, [], "不公开就不推任何更新源");
    first.failStage = null;
    await first.run();
    assert.equal(first.github.state.releases.length, 1, "重跑沿用同一个草稿");
    assert.equal(first.github.state.releases[0].draft, false, "三个都在了才公开");
    assert.deepEqual(first.github.state.releases[0].assets.map((asset) => asset.name), releasePlan("0.3.6", { root }).assets, "一个 Release 里三个包");
    assert.deepEqual(first.finished, ["mac_arm64", "mac_x64", "win"]);

    const missing = scenario();
    missing.skipStage = "win";
    await assert.rejects(missing.run(), /还缺 Navi-0\.3\.6-x64-setup\.exe：没有公开/);
    assert.equal(published(missing), 0, "少一个包不公开");
    assert.deepEqual(missing.finished, []);

    const feeds = scenario();
    feeds.failFinish = "mac_arm64";
    await assert.rejects(feeds.run(), /已经公开（公开不撤回）[\s\S]*Apple 芯片：appcast 409/);
    assert.deepEqual(feeds.finished, ["mac_x64", "win"], "一个更新源没推成不挡另一个");
    feeds.failFinish = null;
    await feeds.run();
    assert.equal(published(feeds), 1, "重跑不重复公开");
    assert.equal(feeds.github.state.calls.filter((call) => call.startsWith("upload")).length, 3, "重跑不重传");

    const moved = scenario({ tagElsewhere: "e".repeat(40) });
    await assert.rejects(moved.run(), /tag 指着 e{40}/);
    assert.deepEqual(moved.finished, [], "tag 不在构建提交上：一个更新源都不推");

    for (const field of ["version", "source"]) {
      writeFileSync(join(runner, PARTS[2].dir, "request.json"), JSON.stringify({ ...request, [field]: field === "version" ? "0.3.7" : "d".repeat(40) }));
      await assert.rejects(scenario().run(), new RegExp(`${field} 不一致`));
    }
    console.log("✓ 合并发布：草稿标题、说明列出三个包；少一个不公开、不推更新源，重跑接着补；齐了公开一次；更新源一个失败不挡另一个、重跑不重复；tag 不对一个都不推；三份原包的版本、提交要一致");
  }

  // ── locate：三份原包都要在 ─────────────────────────────────────────────
  {
    const runner = join(temporary, "locate");
    mkdirSync(runner, { recursive: true });
    const output = join(runner, "github-output");
    const prepare = (restored) => async (part, partEnv) => {
      assert.equal(partEnv.NAVI_RELEASE_DIR, join(runner, part.dir), "每份包各自一个目录");
      assert.equal(partEnv.NAVI_MAC_ARCH, part.env.NAVI_MAC_ARCH);
      writeFileSync(partEnv.GITHUB_OUTPUT, `restore=${restored(part) ? "true" : "false"}\nartifact_id=${part.key}-id\n`);
    };
    await locate({ env: { RUNNER_TEMP: runner, GITHUB_OUTPUT: output }, prepare: prepare(() => true) });
    assert.equal(readFileSync(output, "utf8"), "mac_arm64=mac_arm64-id\nmac_x64=mac_x64-id\nwin=win-id\n");
    await assert.rejects(locate({ env: { RUNNER_TEMP: runner }, prepare: prepare((part) => part.key !== "mac_x64") }), /没有 Intel 的原包/);
    console.log("✓ locate：三份原包各自一个目录、都要在这次运行里存过，产物 id 交给下载那几步");
  }

  // ── 工作流 ────────────────────────────────────────────────────────────
  {
    const root = new URL("..", import.meta.url);
    for (const old of ["release-mac.yml", "release-win.yml"]) assert.ok(!existsSync(new URL(`.github/workflows/${old}`, root)), `${old} 已经并进 release.yml`);
    const yml = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
    const publishJob = yml.slice(yml.indexOf("\n  publish:\n"));
    assert.match(yml, /run-name: release \$\{\{ inputs\.version \}\} \$\{\{ inputs\.source_sha \}\} \$\{\{ inputs\.publish && 'publish' \|\| 'build' \}\}/);
    assert.match(yml, /workflow_dispatch:/);
    assert.doesNotMatch(yml, /^\s+(push|pull_request|pull_request_target|schedule):/m, "只能手动触发");
    for (const line of yml.match(/uses: \S+/g)) assert.match(line, /@[0-9a-f]{40}$/, `action 要钉 sha：${line}`);
    assert.ok(yml.includes("\n  build-mac:\n") && yml.includes("\n  build-win:\n"), "两个平台各自构建");
    assert.match(publishJob, /needs: \[build-mac, build-win\]/, "三份都构建、冒烟过了才发布");
    assert.match(publishJob, /if: inputs\.publish && github\.ref == 'refs\/heads\/main'/);
    assert.match(publishJob, /runs-on: macos-15\n/);
    for (const part of PARTS) {
      assert.match(publishJob, new RegExp(`artifact-ids: \\$\\{\\{ steps\\.request\\.outputs\\.${part.key} \\}\\}`), `${part.label} 的原包按 locate 给的 id 取`);
      assert.ok(publishJob.includes(`path: \${{ runner.temp }}/${part.dir}`), `${part.label} 的原包放进 ${part.dir}`);
    }
    const secretSteps = publishJob.split(/\n      - /).filter((step) => /secrets\./.test(step));
    assert.equal(secretSteps.length, 1, "Secret 只给签名发布那一步");
    assert.match(secretSteps[0], /release-together\.mjs publish/);
    assert.match(secretSteps[0], /GH_TOKEN: \$\{\{ secrets\.MAC_RELEASE_TOKEN \}\}\n\s+MAC_SPARKLE_PRIVATE_KEY: \$\{\{ secrets\.MAC_SPARKLE_PRIVATE_KEY \}\}/);
    assert.ok(publishJob.indexOf("release-together.mjs restore") < publishJob.indexOf("release-together.mjs publish"), "先核对原包再签名");
    assert.match(publishJob, /if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/navi-mac-signing" "\$RUNNER_TEMP\/navi-win-signing"/);
    assert.match(yml, /group: navi-release\n\s+cancel-in-progress: false/, "两次发版不并行");
    console.log("✓ 工作流：一条 release.yml，手动触发、action 钉 sha；publish 等三个构建都过、在 macOS 上、按 id 取三份原包，Secret 只给发布那一步、用完删");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
