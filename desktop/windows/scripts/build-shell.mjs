#!/usr/bin/env node
// 出 Windows x64 的安装包和便携版：
//
//   node desktop/windows/scripts/build-shell.mjs [输出目录]     # 缺省 desktop/windows/build
//     → Navi-<版本>-x64-setup.exe            NSIS 安装包（per-user，装到 %LOCALAPPDATA%\Programs\Navi；更新也用它）
//       Navi-<版本>-x64-setup.exe.sig        给了签名私钥（NAVI_WIN_UPDATER_KEY_FILE）才有：updater 验的就是它
//       Navi\{Navi.exe, runtime\}            便携版：同一个壳 + bundle-runtime.mjs 组装的自带运行时
//
// 壳是 desktop/windows/shell（Tauri 2），打包走 tauri-cli（`cargo tauri build --bundles nsis`，NSIS 模板的定制在
// desktop/windows/installer/）。在 Windows 上要 VS Build Tools 的 MSVC、rustup 和 tauri-cli（GitHub 的 windows runner
// 现成有前两样）。在 mac/Linux 上交叉编：cargo-xwin 当 runner，makensis 用系统的。工具全在用户目录下（缺省
// ~/.cache/navi/win-toolchain，NAVI_WIN_TOOLCHAIN 可换），第一次用先装一遍：
//
//   export RUSTUP_HOME=~/.cache/navi/win-toolchain/rustup CARGO_HOME=~/.cache/navi/win-toolchain/cargo
//   curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal   # 版本跟 shell/rust-toolchain.toml
//   $CARGO_HOME/bin/cargo install --locked cargo-xwin
//   $CARGO_HOME/bin/cargo install --locked tauri-cli --version =<TAURI_CLI>          # 版本见下
//   brew install makensis llvm
//
// 还要 clang-cl / llvm-lib / llvm-rc（Homebrew 的 llvm 就有，找不到时设 NAVI_WIN_LLVM=<bin 目录>）；链接用 rust 自带的 rust-lld。
// MSVC CRT 与 Windows SDK 由 cargo-xwin 第一次构建时下到它自己的缓存里（同在用户目录）。
//
// 环境变量：
//   NAVI_WIN_SKIP_RUNTIME=1          不重新组装运行时、用输出目录里已有的那份（只改了壳时省时间）
//   NAVI_WIN_SKIP_BUILD=1            原样传给 bundle-runtime.mjs（跳过 npm run build）
//   NAVI_WIN_BUILD_VERSION           这一次的版本号（缺省 shell/tauri.conf.json 的 version）
//   NAVI_WIN_FEED_URL                更新清单地址（缺省按 release.json 指向 raw.githubusercontent 上的那份；http 只给本地演练）
//   NAVI_WIN_UPDATER_PUBLIC_KEY      编进壳的更新公钥（缺省 release.json 的 publicKey；本地演练用临时那一把）
//   NAVI_WIN_UPDATER_KEY_FILE        签名私钥文件（base64 的 Ed25519 种子，见 minisign.mjs），给了就给安装包出 .sig
//   NAVI_WIN_REHEARSAL_ENV           本地演练：一组编进 exe 的环境变量（JSON），见 README「本地演练」
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "../../../scripts/env.mjs";
import { signFile } from "./minisign.mjs";
import { feedURL, installerName, readConfig, sourceVersion } from "./release-state.mjs";

export const TAURI_CLI = "2.12.6";
const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = join(HERE, "..");
const SHELL = join(WIN, "shell");
const TARGET = "x86_64-pc-windows-msvc";

const say = (line) => process.stdout.write(`${line}\n`);
const die = (line) => { process.stderr.write(`✕ ${line}\n`); process.exit(1); };

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.error) die(`${command} 起不来：${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} 失败（退出码 ${result.status ?? result.signal}）`);
}

export function crossEnv() {
  const toolchain = resolve(readEnv(process.env, "NAVI_WIN_TOOLCHAIN") || join(homedir(), ".cache", "navi", "win-toolchain"));
  const cargoHome = join(toolchain, "cargo");
  const llvm = readEnv(process.env, "NAVI_WIN_LLVM") || ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"].find((dir) => existsSync(join(dir, "clang-cl")));
  for (const tool of ["cargo-xwin", "cargo-tauri"]) {
    if (!existsSync(join(cargoHome, "bin", tool))) die(`${cargoHome}/bin 里没有 ${tool}，先照本文件开头装一遍工具链`);
  }
  if (!llvm) die("找不到 clang-cl（brew install llvm，或设 NAVI_WIN_LLVM=<llvm 的 bin 目录>）");
  // llvm 放在 PATH 最后：它的 bin 里没有 lld-link，链接器要落到 rust 自带的那份上；也别让它盖掉系统的 clang。
  return { ...process.env, RUSTUP_HOME: join(toolchain, "rustup"), CARGO_HOME: cargoHome, PATH: [join(cargoHome, "bin"), process.env.PATH, llvm].join(delimiter) };
}

/** 这一次要合进 tauri.conf.json 的那一份（版本、自带运行时、更新源）。 */
export function buildConfig({ version, runtime, feed, publicKey }) {
  const updater = { pubkey: publicKey, endpoints: [feed] };
  if (new URL(feed).protocol === "http:") updater.dangerousInsecureTransportProtocol = true;
  return { version, bundle: { active: true, resources: { [`${runtime.replace(/\\/g, "/").replace(/\/?$/, "/")}`]: "runtime/" } }, plugins: { updater } };
}

function main() {
  const OUT = resolve(process.argv[2] || join(WIN, "build"));
  const config = readConfig(join(WIN, "release.json"));
  const version = readEnv(process.env, "NAVI_WIN_BUILD_VERSION") || sourceVersion(readFileSync(join(SHELL, "tauri.conf.json"), "utf8"));
  const feed = readEnv(process.env, "NAVI_WIN_FEED_URL") || feedURL(config);
  const publicKey = readEnv(process.env, "NAVI_WIN_UPDATER_PUBLIC_KEY") || config.publicKey;
  const portable = join(OUT, "Navi");

  // ── 1. 自带运行时 ──────────────────────────────────────────────────────────
  const runtime = join(portable, "runtime");
  if (readEnv(process.env, "NAVI_WIN_SKIP_RUNTIME") === "1" && existsSync(join(runtime, ".runtime.json"))) say(`▶ 沿用 ${runtime}`);
  else run(process.execPath, [join(HERE, "bundle-runtime.mjs"), runtime]);

  // ── 2. 壳 + 安装包 ─────────────────────────────────────────────────────────
  say(`▶ 编 Navi.exe 并打安装包（${TARGET}，版本 ${version}，更新源 ${feed}）`);
  const scratch = mkdtempSync(join(tmpdir(), "navi-win-build-"));
  try {
    const merged = join(scratch, "tauri.build.json");
    writeFileSync(merged, JSON.stringify(buildConfig({ version, runtime, feed, publicKey })));
    const args = ["tauri", "build", "--ci", "--target", TARGET, "--bundles", "nsis", "--config", merged];
    const rehearsal = readEnv(process.env, "NAVI_WIN_REHEARSAL_ENV");
    const env = { ...(process.platform === "win32" ? process.env : crossEnv()), NAVI_WIN_REHEARSAL_ENV: rehearsal || "" };
    if (!rehearsal) delete env.NAVI_WIN_REHEARSAL_ENV;
    if (process.platform === "win32") run("cargo", [...args, "--", "--locked"], { cwd: SHELL, env });
    else run(join(env.CARGO_HOME, "bin", "cargo"), [...args, "--runner", "cargo-xwin", "--", "--locked"], { cwd: SHELL, env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const release = join(SHELL, "target", TARGET, "release");
  const setup = join(release, "bundle", "nsis", `Navi_${version}_x64-setup.exe`);
  if (!existsSync(setup)) die(`tauri 没出 ${setup}`);

  // ── 3. 摆好 ────────────────────────────────────────────────────────────────
  mkdirSync(OUT, { recursive: true });
  rmSync(join(portable, "Navi.exe"), { force: true });
  cpSync(join(release, "Navi.exe"), join(portable, "Navi.exe"));
  const installer = join(OUT, installerName(version));
  for (const stale of [installer, `${installer}.sig`]) rmSync(stale, { force: true });
  cpSync(setup, installer);
  const key = readEnv(process.env, "NAVI_WIN_UPDATER_KEY_FILE");
  if (key) writeFileSync(`${installer}.sig`, signFile(installer, version, readFileSync(key, "utf8")));
  say(`✓ ${OUT}`);
  say(`  ${installerName(version)}  ${(statSync(installer).size / 1048576).toFixed(1)} MB${key ? "（已签名）" : ""}`);
  say("  Navi\\Navi.exe + runtime\\  便携版（壳旁边的运行时只是发布源，服务从 %LOCALAPPDATA%\\Navi\\runtimes\\<sha256>\\ 跑）");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
