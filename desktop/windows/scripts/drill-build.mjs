#!/usr/bin/env node
// 在开发机上做一份真机演练的载荷（安装 → 更新 → 交接 → navi:// → 卸载，install-check.mjs 在测试机上跑它）：
//
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/drill-build.mjs [输出目录]     # 缺省 desktop/windows/build/drill
//   WIN_REMOTE_KEY=… node desktop/windows/scripts/remote-smoke.mjs --install desktop/windows/build/drill/payload
//
// 出两版演练安装包（0.0.1、0.0.2），和正式包只差这几样：
//   · 壳里编进一组环境变量（NAVI_WIN_REHEARSAL_ENV）：LOCALAPPDATA、USERPROFILE、APPDATA 指到测试机上这次演练的根
//     （%TEMP%\navi-win-runtime-<id>\ 下），服务端口 14977 —— 数据、运行时仓库、WebView2 数据、服务的家目录都在那里，
//     不碰那台机器上的日常数据和 :4317。编进 exe 而不是由启动方传：更新装完是安装包把新壳打开的，它不带演练时的环境。
//   · 更新源是测试机本机的 http://127.0.0.1:14981/latest.json（install-check.mjs 起的小服务），更新公钥是这次现生成的
//     一把临时钥匙。私钥只在这台机器的临时目录里活到签完 0.0.2 那一下，载荷里只有公钥和签名。
//   · 两版的自带运行时内容不同（0.0.2 那份多一个标记文件、重新封清单），这样装了新版才真有「换运行时」可演练。
// <id> 现在定下（测试机上的根目录名也编进了安装包），写在 payload\drill.json 里，remote-smoke 按它记账、收尾。
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, rexec } from "../../../scripts/win-remote/transport.mjs";
import { sealRuntime } from "../../shared/runtime-store.mjs";
import { minisignPublicKey } from "./minisign.mjs";
import { remoteRootName } from "./remote-scratch.mjs";
import { installerName } from "./release-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] || join(HERE, "..", "build", "drill"));
const FROM = "0.0.1";
const TO = "0.0.2";
const PORT = 14977;
const FEED_PORT = 14981;
const say = (line) => process.stdout.write(`${line}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")} 失败（${result.status ?? result.signal}）`);
}

const id = randomBytes(6).toString("hex");
const probe = await rexec("Write-Output $env:TEMP", { timeout: 60_000, host: DEFAULT_HOST });
const temp = probe.out.trim().split(/\r?\n/).at(-1);
if (probe.code !== 0 || !/^[A-Za-z]:\\/.test(temp)) throw new Error(`问不到测试机的 %TEMP%：${probe.out}`);
const root = `${temp}\\${remoteRootName(id)}`;
say(`▶ 演练根（测试机上）：${root}`);

rmSync(OUT, { recursive: true, force: true });
const payload = join(OUT, "payload");
mkdirSync(join(payload, "feed"), { recursive: true });
const keys = mkdtempSync(join(tmpdir(), "navi-drill-key-"));
chmodSync(keys, 0o700);
try {
  // ── 两份运行时 ──
  const base = join(HERE, "..", "build", "Navi", "runtime");
  if (process.env.NAVI_WIN_SKIP_RUNTIME !== "1" || !existsSync(join(base, ".runtime.json"))) run(process.execPath, [join(HERE, "bundle-runtime.mjs"), base]);
  for (const [version, dir] of [[FROM, "a"], [TO, "b"]]) {
    const target = join(OUT, dir, "Navi", "runtime");
    cpSync(base, target, { recursive: true });
    if (version === TO) {
      writeFileSync(join(target, `drill-${version}.txt`), `navi drill ${version}\n`);
      sealRuntime(target, { platform: "win32" });
    }
    say(`▶ ${version} 的运行时 ${JSON.parse(readFileSync(join(target, ".runtime.json"), "utf8")).id.slice(0, 12)}`);
  }

  // ── 临时更新钥匙 ──
  const pair = generateKeyPairSync("ed25519");
  const key = join(keys, "drill.key");
  writeFileSync(key, Buffer.from(pair.privateKey.export({ format: "jwk" }).d, "base64url").toString("base64"), { mode: 0o600 });
  const publicKey = minisignPublicKey(Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url"));

  // ── 两版安装包 ──
  const rehearsal = JSON.stringify({
    LOCALAPPDATA: `${root}\\l`, USERPROFILE: `${root}\\h`, HOME: `${root}\\h`, APPDATA: `${root}\\h\\AppData\\Roaming`,
    NAVI_URL: `http://127.0.0.1:${PORT}`,
  });
  for (const [version, dir] of [[FROM, "a"], [TO, "b"]]) {
    say(`▶ 编 ${version} 的演练安装包`);
    run(process.execPath, [join(HERE, "build-shell.mjs"), join(OUT, dir)], {
      env: {
        ...process.env, NAVI_WIN_SKIP_RUNTIME: "1", NAVI_WIN_BUILD_VERSION: version, NAVI_WIN_FEED_URL: `http://127.0.0.1:${FEED_PORT}/latest.json`,
        NAVI_WIN_UPDATER_PUBLIC_KEY: publicKey, NAVI_WIN_REHEARSAL_ENV: rehearsal, NAVI_WIN_UPDATER_KEY_FILE: "",
      },
    });
    cpSync(join(OUT, dir, installerName(version)), join(payload, installerName(version)));
  }

  // ── 本地更新源：新版按临时私钥签、用临时公钥验过 ──
  run(process.execPath, [join(HERE, "release.mjs"), "--installer", join(payload, installerName(TO)), "--version", TO, "--key-file", key,
    "--local", join(payload, "feed"), "--base-url", `http://127.0.0.1:${FEED_PORT}/`, "--notes", "真机演练：只换壳，服务和终端不停。"], {
    env: { ...process.env, NAVI_WIN_UPDATER_PUBLIC_KEY: publicKey },
  });
  writeFileSync(join(payload, "drill.json"), `${JSON.stringify({ id, root, port: PORT, feedPort: FEED_PORT, from: FROM, to: TO }, null, 2)}\n`);
  say(`✓ ${payload}`);
} finally {
  rmSync(keys, { recursive: true, force: true });
}
