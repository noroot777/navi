// Windows 发版的那一头（desktop/windows/scripts/release-state.mjs、minisign.mjs、release.mjs，在 mac 上也跑）：
//   · 版本号只改 tauri.conf.json 那一行；更新清单读写成 Tauri updater 的格式，认不出的不当成「还没发过」
//   · 签名按 minisign 验（拿一份 tauri-cli 真签出来的样本钉住格式）：换了文件、换了钥匙、改了版本都验不过
//   · 签名由 node 按 tauri-cli 的格式签，钥匙是 Sparkle 导出的那种 Ed25519 种子；release.json 的公钥就是 mac 那把算出来的
//   · 发布：签名验不过 release.json 的公钥就什么都不传；包先进草稿、下回核对、公开、确认下得下来，最后才推清单；
//     清单里已是同一版同一包时不重签不重传，同一版换了包拒发；清单提交不上时包已公开、说清重跑
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { minisignPublicKey, parsePublicKey, readSigningKey, signFile, verifySignature } from "../desktop/windows/scripts/minisign.mjs";
import { assertNewer, installerName, parseFeed, renderFeed, sourceVersion, withVersion } from "../desktop/windows/scripts/release-state.mjs";
import { buildConfig } from "../desktop/windows/scripts/build-shell.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-windows-release-"));
const b64 = (value) => Buffer.from(value).toString("base64");

// tauri-cli 2.12.6 `signer sign --app-version 0.0.2` 给内容为 "hello\n" 的文件签出来的（临时钥匙，用完即弃）。
const SAMPLE = {
  file: Buffer.from("hello\n"),
  publicKey: "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY3NTg0MkYwMjRDNDIxNkYKUldSdkljUWs4RUpZOTlmR2dIRXZCQU9PazJ1bXJxeTY1Y1lURXRVRzNvamlVT1ZFM3QzaEo3SUsK",
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSdkljUWs4RUpZOXdLMUh1R2VaQTlHVXJwTEZHSC9UZ04wcnlGOWRHQXVnU1M2aUxWRTM1c0NRc0owMTc1TmtLeVdzdlpsblF2WWVzNHc5cXRrVVEvZnBYSDdCOEpBcGdZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NjIyMTI5CWZpbGU6Zi5leGUJdmVyc2lvbjowLjAuMgo1RW5JS3NNVTBTRE1oUmw2VloyTW5DR0R1OVJKc3lwZGJSV3RJeFBtcUU0blRzNTZXREp5ajV2SXVJMktsdXFOOFM5L214ZUFVOUV3RURJd0MxMW5BZz09Cg==",
};

/** 一把测试用的钥匙，存成 Sparkle generate_keys -x 导出的样子（base64 的 32 字节种子），用发版脚本自己的签名函数签。 */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const file = join(temporary, `key-${randomBytes(4).toString("hex")}`);
  writeFileSync(file, `${b64(seed)}\n`);
  return { file, seed, raw, publicKey: minisignPublicKey(raw), sign: (target, version) => signFile(target, version, readFileSync(file, "utf8")) };
}

try {
  // ── 版本号与更新清单 ──────────────────────────────────────────────────
  {
    const conf = '{\n  "productName": "Navi",\n  "version": "0.1.0",\n  "identifier": "dev.navi.win",\n  "plugins": { "x": { "version": "9" } }\n}\n';
    assert.equal(sourceVersion(conf), "0.1.0");
    const next = withVersion(conf, "0.2.0");
    assert.equal(sourceVersion(next), "0.2.0");
    assert.equal(next.replace('"0.2.0"', '"0.1.0"'), conf, "只改顶层 version 那一行");
    assert.throws(() => withVersion(conf, "0.2"), /版本/);
    assert.throws(() => sourceVersion('{ "version": "v1" }'));
    assert.equal(parseFeed(null), null);
    assert.throws(() => parseFeed("not json"), /JSON/);
    assert.throws(() => parseFeed('{"version":"0.1.0","platforms":{}}'), /windows-x86_64/, "认不出的清单不当成还没发过");
    const feed = renderFeed({ version: "0.1.0", notes: "- a", url: "https://x/Navi-0.1.0-x64-setup.exe", signature: "SIG", commit: "c".repeat(40), sha256: "d".repeat(64), size: 5, date: new Date("2026-11-25T01:02:03.456Z") });
    const parsed = JSON.parse(feed);
    assert.equal(parsed.pub_date, "2026-11-25T01:02:03Z");
    assert.deepEqual(parsed.platforms, { "windows-x86_64": { url: "https://x/Navi-0.1.0-x64-setup.exe", signature: "SIG" } });
    const latest = parseFeed(feed);
    assert.equal(latest.commit, "c".repeat(40));
    assert.equal(assertNewer("0.1.1", latest, "e".repeat(40)), "fresh");
    assert.equal(assertNewer("0.1.0", latest, "c".repeat(40)), "published", "同一版同一提交：补收尾");
    assert.throws(() => assertNewer("0.1.0", latest, "e".repeat(40)), /另一个提交/);
    assert.throws(() => assertNewer("0.0.9", latest, "c".repeat(40)), /更旧/);
    assert.equal(installerName("0.1.0"), "Navi-0.1.0-x64-setup.exe");
    const built = buildConfig({ version: "0.1.0", runtime: "C:\\b\\runtime", feed: "http://10.0.0.2:8000/latest.json", publicKey: "PK" });
    assert.deepEqual(built.bundle.resources, { "C:/b/runtime/": "runtime/" });
    assert.equal(built.plugins.updater.dangerousInsecureTransportProtocol, true, "http 更新源只给演练，要显式放行");
    assert.equal(buildConfig({ version: "0.1.0", runtime: "/r", feed: "https://raw.githubusercontent.com/a/b/main/x.json", publicKey: "PK" }).plugins.updater.dangerousInsecureTransportProtocol, undefined);
    console.log("✓ 版本号只改 tauri.conf.json 那一行；清单按 updater 格式读写、认不出就报错；同一版只认同一提交；http 更新源要显式放行");
  }

  // ── minisign ──────────────────────────────────────────────────────────
  {
    assert.deepEqual(verifySignature(SAMPLE.file, SAMPLE.signature, SAMPLE.publicKey, { version: "0.0.2" }).keyId, "F75842F024C4216F");
    assert.throws(() => verifySignature(Buffer.from("hellO\n"), SAMPLE.signature, SAMPLE.publicKey), /对不上/);
    assert.throws(() => verifySignature(SAMPLE.file, SAMPLE.signature, SAMPLE.publicKey, { version: "0.0.3" }), /绑的版本是 0\.0\.2/);
    const other = testKey();
    assert.throws(() => verifySignature(SAMPLE.file, SAMPLE.signature, other.publicKey), /不是一对/);
    const text = Buffer.from(SAMPLE.signature, "base64").toString().replace("version:0.0.2", "version:9.9.9");
    assert.throws(() => verifySignature(SAMPLE.file, b64(text), SAMPLE.publicKey), /trusted comment 被改过/);
    assert.throws(() => verifySignature(SAMPLE.file, "garbage", SAMPLE.publicKey), /minisign/);
    const release = JSON.parse(readFileSync(new URL("../desktop/windows/release.json", import.meta.url), "utf8"));
    assert.match(parsePublicKey(release.publicKey).keyId, /^[0-9A-F]{16}$/, "release.json 里是一把能解析的公钥");
    const file = join(temporary, "probe.exe");
    writeFileSync(file, "MZ probe");
    assert.equal(verifySignature(readFileSync(file), other.sign(file, "1.0.0"), other.publicKey, { version: "1.0.0" }).version, "1.0.0");
    console.log("✓ minisign：tauri-cli 真签的样本验得过；换文件、换钥匙、改版本、改 trusted comment 都验不过");

    const mac = JSON.parse(readFileSync(new URL("../desktop/macos/release.json", import.meta.url), "utf8"));
    assert.equal(release.publicKey, minisignPublicKey(mac.publicKey), "Windows 的公钥就是 mac 那把 Ed25519 算出来的：私钥共用 MAC_SPARKLE_PRIVATE_KEY");
    const signed = other.sign(file, "1.0.0");
    const rows = Buffer.from(signed, "base64").toString().split("\n");
    assert.equal(rows[0], Buffer.from(SAMPLE.signature, "base64").toString().split("\n")[0], "和 tauri-cli 出的签名同一个样子");
    assert.match(rows[2], /^trusted comment: timestamp:\d+\tfile:probe\.exe\tversion:1\.0\.0$/);
    assert.equal(verifySignature(readFileSync(file), signed, other.publicKey).keyId, parsePublicKey(other.publicKey).keyId, "key id 由公钥推出，签名和公钥对得上");
    assert.equal(minisignPublicKey(other.raw), minisignPublicKey(b64(other.raw)), "同一把公钥永远算出同一份");
    assert.ok(readSigningKey(b64(Buffer.concat([other.seed, other.raw]))).publicKey.equals(other.raw), "种子 + 公钥的 64 字节也认");
    assert.throws(() => readSigningKey(b64(Buffer.concat([other.seed, randomBytes(32)]))), /对不上/);
    assert.throws(() => readSigningKey(b64(randomBytes(96))), /96 字节/, "旧版 Sparkle 的展开私钥推不回种子，拒");
    assert.throws(() => signFile(file, "1.0.0", Buffer.from(SAMPLE.publicKey, "base64").toString()), /字节/, "不是 Ed25519 种子就拒");
    console.log("✓ 签名：node 按 tauri-cli 的格式签，钥匙是 Sparkle 导出的种子；release.json 的公钥由 mac 的公钥算出；旧版 96 字节私钥拒");
  }

  // ── 发布 ──────────────────────────────────────────────────────────────
  const key = testKey();
  const config = { releaseRepo: "o/navi", feedRepo: "o/materials", feedBranch: "main", feedPath: "navi/win/latest.json", tagPrefix: "navi-win-v", publicKey: key.publicKey };
  const configFile = join(temporary, "release.json");
  writeFileSync(configFile, JSON.stringify(config));
  process.env.NAVI_WIN_RELEASE_CONFIG = configFile;
  const { release } = await import("../desktop/windows/scripts/release.mjs");
  const COMMIT = "a".repeat(40);
  const installer = (version, body = `MZ installer ${version}`) => {
    const dir = join(temporary, `build-${version}-${randomBytes(3).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, installerName(version));
    writeFileSync(file, body);
    return file;
  };
  const quiet = async (operation) => {
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try { return await operation(); } finally { process.stdout.write = write; }
  };

  // 本地演练：清单和包写进目录，地址按 --base-url
  {
    const local = join(temporary, "feed");
    const file = installer("0.0.1");
    const out = await quiet(() => release({ installer: file, version: "0.0.1", keyFile: key.file, local, baseURL: "http://10.0.0.2:8000", notes: "演练" }));
    assert.equal(out.url, "http://10.0.0.2:8000/Navi-0.0.1-x64-setup.exe");
    const feed = parseFeed(readFileSync(join(local, "latest.json"), "utf8"));
    assert.equal(feed.version, "0.0.1");
    assert.ok(existsSync(join(local, "Navi-0.0.1-x64-setup.exe")));
    verifySignature(readFileSync(file), feed.signature, key.publicKey, { version: "0.0.1" });
    await assert.rejects(quiet(() => release({ installer: installer("0.0.0"), version: "0.0.0", keyFile: "k", local, baseURL: "http://x/", signer: key.sign })), /更旧/);
    await assert.rejects(quiet(() => release({ installer: file, version: "0.0.2", keyFile: "k", local, baseURL: "http://x/", signer: key.sign })), /该叫 Navi-0\.0\.2/);
    console.log("✓ 本地演练：安装包和 latest.json 写进目录，签名验得过，版本只能往前、文件名要对");
  }

  // 正式发布：假 GitHub + 真 http 下载地址
  {
    const assets = new Map();
    const server = createServer((request, response) => {
      const body = assets.get(request.url);
      response.writeHead(body ? 200 : 404);
      response.end(body ?? "");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const fake = (overrides = {}) => {
      const state = { calls: [], feed: null, releases: new Map(), writes: [], tags: new Map() };
      const github = {
        state,
        canWrite: async (repo) => { state.calls.push(`canWrite ${repo}`); return true; },
        branchRestrictions: async () => [],
        readFile: async () => state.feed,
        writeFile: async (repo, file) => { state.calls.push(`writeFile ${repo}/${file.path}`); state.writes.push(file); state.feed = { text: file.text, sha: "new" }; },
        commitSha: async (repo, commit) => commit,
        tagCommit: async (repo, tag) => state.tags.get(tag) ?? null,
        findRelease: async (repo, tag) => state.releases.get(tag) ?? null,
        createDraftRelease: async (repo, { tag, target, name }) => {
          state.calls.push(`draft ${tag}`);
          const made = { id: 1, tag_name: tag, draft: true, assets: [], target, name };
          state.releases.set(tag, made);
          return made;
        },
        uploadAsset: async (made, file) => {
          state.calls.push(`upload ${basename(file)}`);
          const asset = { name: basename(file), size: statSync(file).size, url: file, browser_download_url: `${origin}/${made.tag_name}/${basename(file)}` };
          made.assets.push(asset);
          assets.set(`/${made.tag_name}/${basename(file)}`, readFileSync(file));
          return asset;
        },
        downloadAsset: async (asset) => readFileSync(asset.url),
        publishRelease: async (repo, made, target) => { state.calls.push(`publish ${made.tag_name}`); made.draft = false; state.tags.set(made.tag_name, target); return made; },
        ...overrides,
      };
      return github;
    };

    const github = fake();
    const file = installer("0.1.0");
    await quiet(() => release({ installer: file, version: "0.1.0", commit: COMMIT, keyFile: "k", github, signer: key.sign, notes: "第一版" }));
    assert.deepEqual(github.state.calls, ["canWrite o/navi", "canWrite o/materials", "draft navi-win-v0.1.0", "upload Navi-0.1.0-x64-setup.exe",
      "publish navi-win-v0.1.0", "writeFile o/materials/navi/win/latest.json"], "先确认两个仓库都写得了；包公开、下得下来之后才推清单");
    const feed = parseFeed(github.state.feed.text);
    assert.equal(feed.url, `${origin}/navi-win-v0.1.0/Navi-0.1.0-x64-setup.exe`);
    assert.equal(feed.sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
    assert.equal(feed.commit, COMMIT);

    // 同一版同一包：只认出来，不重签不重传
    let signed = 0;
    const again = await quiet(() => release({ installer: file, version: "0.1.0", commit: COMMIT, keyFile: "k", github, signer: (...args) => { signed += 1; return key.sign(...args); } }));
    assert.equal(again.already, true);
    assert.equal(signed, 0);
    await assert.rejects(quiet(() => release({ installer: installer("0.1.0", "MZ another build"), version: "0.1.0", commit: COMMIT, keyFile: "k", github, signer: key.sign })), /不是这个包/);

    // 私钥和 release.json 的公钥不是一对：一个字节都不传
    const wrong = fake();
    await assert.rejects(quiet(() => release({ installer: installer("0.2.0"), version: "0.2.0", commit: COMMIT, keyFile: "k", github: wrong, signer: testKey().sign })), /不是一对.*什么都没传/s);
    assert.ok(!wrong.state.calls.some((call) => /draft|upload|writeFile/.test(call)));

    // 有一个仓库写不了：什么都不传
    const readOnly = fake({ canWrite: async (repo) => repo !== "o/materials" });
    await assert.rejects(quiet(() => release({ installer: installer("0.2.0"), version: "0.2.0", commit: COMMIT, keyFile: "k", github: readOnly, signer: key.sign })), /没有写权限/);
    assert.deepEqual(readOnly.state.calls, []);

    // 草稿里下回来的不是这份：不公开、不推清单
    const corrupt = fake({ downloadAsset: async () => Buffer.from("MZ truncated") });
    await assert.rejects(quiet(() => release({ installer: installer("0.2.0"), version: "0.2.0", commit: COMMIT, keyFile: "k", github: corrupt, signer: key.sign })), /没有公开/);
    assert.ok(!corrupt.state.calls.some((call) => /publish|writeFile/.test(call)));

    // 清单提交不上：包已公开，说清重跑
    const conflict = fake({ writeFile: async () => { throw new Error("HTTP 409"); } });
    await assert.rejects(quiet(() => release({ installer: installer("0.2.0"), version: "0.2.0", commit: COMMIT, keyFile: "k", github: conflict, signer: key.sign })), /没提交上.*公开不撤回.*重跑/s);

    // 合并发布的两段：--stage 只进草稿、不公开、不推清单；--finish 只认已公开的 Release，公开后才推清单
    const together = fake();
    const shared = installer("0.3.6");
    await assert.rejects(quiet(() => release({ installer: shared, version: "0.3.6", commit: COMMIT, keyFile: "k", github: together, signer: key.sign, mode: "finish" })), /还没公开/);
    const staged = await quiet(() => release({ installer: shared, version: "0.3.6", commit: COMMIT, keyFile: "k", github: together, signer: key.sign, mode: "stage" }));
    assert.equal(staged.staged, true);
    assert.ok(!together.state.calls.some((call) => /publish|writeFile/.test(call)), "stage 不公开、不推清单");
    assert.equal(together.state.releases.get("navi-win-v0.3.6").draft, true);
    await together.publishRelease("o/navi", together.state.releases.get("navi-win-v0.3.6"), COMMIT);
    await quiet(() => release({ installer: shared, version: "0.3.6", commit: COMMIT, keyFile: "k", github: together, signer: key.sign, mode: "finish" }));
    assert.equal(parseFeed(together.state.feed.text).version, "0.3.6", "finish 在公开之后推清单");
    assert.equal(together.state.calls.filter((call) => call.startsWith("upload")).length, 1, "finish 不重传");
    await assert.rejects(release({ installer: shared, version: "0.3.6", keyFile: key.file, local: join(temporary, "x"), baseURL: "http://x/", mode: "stage" }), /不和 --local 一起用/);
    server.close();
    console.log("✓ 正式发布：两个仓库先证明写得了；签名验不过公钥、草稿下回来不对都不公开；包公开且下得下来才推清单；同版同包不重发，同版换包拒发");
    console.log("✓ 合并发布的两段：stage 只进草稿、不公开、不推清单；finish 只认已公开的 Release，公开后推清单、不重传");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
