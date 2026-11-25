#!/usr/bin/env node
// 出 Windows x64 的便携版：Navi.exe（desktop/windows/shell 的 Tauri 壳）+ 旁边的 runtime\（bundle-runtime.mjs 组装的自带运行时）。
//
//   node desktop/windows/scripts/build-shell.mjs [输出目录]     # 缺省 desktop/windows/build/Navi
//
// 在 Windows 上就是普通的 cargo build（要 VS Build Tools 的 MSVC 和 rustup；GitHub 的 windows runner 都现成）。
// 在 mac/Linux 上走 cargo-xwin 交叉编译：工具全在用户目录下（缺省 ~/.cache/navi/win-toolchain，NAVI_WIN_TOOLCHAIN 可换），
// 第一次用先装一遍：
//
//   export RUSTUP_HOME=~/.cache/navi/win-toolchain/rustup CARGO_HOME=~/.cache/navi/win-toolchain/cargo
//   curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal   # 版本跟 shell/rust-toolchain.toml
//   $CARGO_HOME/bin/cargo install --locked cargo-xwin
//
// 还要 clang-cl / llvm-lib / llvm-rc（Homebrew 的 llvm 就有，找不到时设 NAVI_WIN_LLVM=<bin 目录>）；链接用 rust 自带的 rust-lld。
// MSVC CRT 与 Windows SDK 由 cargo-xwin 第一次构建时下到它自己的缓存里（同在用户目录）。
//
// 环境变量：NAVI_WIN_SKIP_RUNTIME=1 不重新组装运行时、用输出目录里已有的那份（只改了壳时省时间）；
// NAVI_WIN_SKIP_BUILD=1 原样传给 bundle-runtime.mjs（跳过 npm run build）。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "../../../scripts/env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = join(HERE, "..", "shell");
const TARGET = "x86_64-pc-windows-msvc";
const OUT = resolve(process.argv[2] || join(HERE, "..", "build", "Navi"));

const say = (line) => process.stdout.write(`${line}\n`);
const die = (line) => { process.stderr.write(`✕ ${line}\n`); process.exit(1); };

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.error) die(`${command} 起不来：${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(" ")} 失败（退出码 ${result.status ?? result.signal}）`);
}

function crossEnv() {
  const toolchain = resolve(readEnv(process.env, "NAVI_WIN_TOOLCHAIN") || join(homedir(), ".cache", "navi", "win-toolchain"));
  const cargoHome = join(toolchain, "cargo");
  const llvm = readEnv(process.env, "NAVI_WIN_LLVM") || ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"].find((dir) => existsSync(join(dir, "clang-cl")));
  if (!existsSync(join(cargoHome, "bin", "cargo-xwin"))) die(`${cargoHome}/bin 里没有 cargo-xwin，先照本文件开头装一遍工具链`);
  if (!llvm) die("找不到 clang-cl（brew install llvm，或设 NAVI_WIN_LLVM=<llvm 的 bin 目录>）");
  // llvm 放在 PATH 最后：它的 bin 里没有 lld-link，链接器要落到 rust 自带的那份上；也别让它盖掉系统的 clang。
  return { ...process.env, RUSTUP_HOME: join(toolchain, "rustup"), CARGO_HOME: cargoHome, PATH: [join(cargoHome, "bin"), process.env.PATH, llvm].join(delimiter) };
}

// ── 1. 壳 ───────────────────────────────────────────────────────────────────
say(`▶ 编 Navi.exe（${TARGET}）`);
if (process.platform === "win32") {
  run("cargo", ["build", "--release", "--locked", "--target", TARGET], { cwd: SHELL });
} else {
  run(join(crossEnv().CARGO_HOME, "bin", "cargo"), ["xwin", "build", "--release", "--locked", "--target", TARGET], { cwd: SHELL, env: crossEnv() });
}
const exe = join(SHELL, "target", TARGET, "release", "navi.exe");

// ── 2. 自带运行时 ────────────────────────────────────────────────────────────
const runtime = join(OUT, "runtime");
if (readEnv(process.env, "NAVI_WIN_SKIP_RUNTIME") === "1" && existsSync(join(runtime, ".runtime.json"))) {
  say(`▶ 沿用 ${runtime}`);
} else {
  run(process.execPath, [join(HERE, "bundle-runtime.mjs"), runtime]);
}

// ── 3. 摆好 ─────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, "Navi.exe"), { force: true });
cpSync(exe, join(OUT, "Navi.exe"));
say(`✓ ${OUT}`);
say(`  Navi.exe  ${(statSync(join(OUT, "Navi.exe")).size / 1048576).toFixed(1)} MB`);
say("  runtime\\  自带运行时（壳旁边这份只是发布源，服务从 %LOCALAPPDATA%\\Navi\\runtimes\\<sha256>\\ 跑）");
