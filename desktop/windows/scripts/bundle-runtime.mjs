#!/usr/bin/env node
// 组装 Windows x64 的自带运行时目录：固定版本的 node.exe、shared/web/server/mcp 产物、按 win32-x64 装的
// 生产依赖（node-pty 用它自带的 ConPTY 预编译包）。在 mac 开发机上就能做，不编译任何东西。
//
//   node desktop/windows/scripts/bundle-runtime.mjs [输出目录]     # 缺省 desktop/windows/build/runtime
//
// 布局与仓库同形（server 认代码根 = server/dist 往上两级，见 server/src/data-root.ts）：
//
//   node/node.exe, node/LICENSE     自带运行时（不带 npm）
//   package.json                    仓库根的那份（workspaces 声明，供 shared 的自引用解析）
//   node_modules/                   server + mcp 的生产依赖，**一个链接都没有**；@navi/shared 是转发包（win-deps.mjs）
//   shared/{package.json,src}       shared 的导出直接指 .ts 源码，靠 node 的类型擦除跑，所以在 node_modules 外面
//   server/{package.json,dist}  mcp/{package.json,dist}  web/dist
//   scripts/start-detached.mjs, scripts/runtime-store.mjs
//   .in-use, .handover.json, .runtime.json   代码锁文件与内容清单（清单 format 2，见 desktop/shared/runtime-store.mjs）
//
// 用的时候先发布到 %LOCALAPPDATA%\Navi\runtimes\<sha256>\ 再从那里跑（layout.mjs、smoke-runtime.mjs）。
//
// 环境变量：NAVI_WIN_SKIP_BUILD=1 跳过 `npm run build`；NAVI_WIN_CACHE=<目录> 换缓存位置（缺省 desktop/windows/build/cache）。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readEnv } from "../../../scripts/env.mjs";
import { sealRuntime } from "../../shared/runtime-store.mjs";
import { NODE_VERSION, REPO, buildProducts, cachedDependencies, copyProducts, dependencyKey, die, fetchNode, run, say, unpackOnce } from "../../shared/runtime-bundle.mjs";
import { scanWindowsBinaries } from "./binary-check.mjs";
import { WINDOWS_TARGET, findLinks, installWindowsDependencies, writeSharedForwarder } from "./win-deps.mjs";

const NODE_HOME = `node-${NODE_VERSION}-win-x64`;
const NODE_ARCHIVE = `${NODE_HOME}.zip`;
// https://nodejs.org/dist/v26.13.1/SHASUMS256.txt
const NODE_SHA256 = "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7";
// 运行时目录名本身是 64 位 sha256，再加上 %LOCALAPPDATA%\Navi\runtimes\ 和用户名，留给包内相对路径的
// 余量按 MAX_PATH（260）算大约 150；超过的话安装器、资源管理器这些不走长路径的工具会出问题。
const MAX_RELATIVE_PATH = 150;

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(readEnv(process.env, "NAVI_WIN_CACHE") || join(HERE, "..", "build", "cache"));
const APP = resolve(process.argv[2] || join(HERE, "..", "build", "runtime"));

// ── 1. 产物 ────────────────────────────────────────────────────────────────
buildProducts({ skip: readEnv(process.env, "NAVI_WIN_SKIP_BUILD") === "1" });

// ── 2. node（zip 用 tar 解：macOS 和 Windows 10 起自带的 tar 都是 bsdtar，认 zip）────────────
const archive = await fetchNode(CACHE, NODE_ARCHIVE, NODE_SHA256);
const nodeHome = unpackOnce(CACHE, NODE_HOME, "node.exe",
  (unpacking) => run("tar", ["-xf", archive, "-C", unpacking, "--strip-components", "1"]));
const npmCli = join(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");

// ── 3. 生产依赖 ────────────────────────────────────────────────────────────
const recipe = readFileSync(join(HERE, "win-deps.mjs"), "utf8");
const header = `${NODE_VERSION}\n${WINDOWS_TARGET.os}-${WINDOWS_TARGET.cpu}\nnode-pty: prebuilds\n${recipe}\n`;
const deps = cachedDependencies(CACHE, `win-${dependencyKey(header)}`, (stage) => {
  say(`▶ 按 ${WINDOWS_TARGET.os}-${WINDOWS_TARGET.cpu} 安装生产依赖`);
  installWindowsDependencies(stage, npmCli);
});

// ── 4. 组装 ─────────────────────────────────────────────────────────────────
say(`▶ 组装 ${APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, "node"), { recursive: true });
cpSync(join(nodeHome, "node.exe"), join(APP, "node", "node.exe"));
cpSync(join(nodeHome, "LICENSE"), join(APP, "node", "LICENSE"));
cpSync(join(deps, "node_modules"), join(APP, "node_modules"), { recursive: true });
copyProducts(APP);
const forwarded = writeSharedForwarder(join(APP, "node_modules"), join(REPO, "shared/package.json"));

// ── 5. 自检（在哪台机器上组装都能做的那部分；真起服务的冒烟在 smoke-runtime.mjs，得在 Windows 上跑）──
const links = findLinks(APP);
if (links.length) die(`运行时里有链接：\n  ${links.join("\n  ")}`);
const { problems, native } = scanWindowsBinaries(APP);
if (problems.length) die(`运行时里有不是 Windows x64 的二进制：\n  ${problems.join("\n  ")}`);
for (const required of ["node/node.exe", `node_modules/node-pty/prebuilds/win32-x64/conpty.node`, "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll"]) {
  if (!native.includes(required)) die(`缺少 ${required}`);
}
const collisions = caseCollisions(APP);
if (collisions.length) die(`有只差大小写的路径，NTFS 上会撞在一起：\n  ${collisions.join("\n  ")}`);
const longest = longestPath(APP);
if (longest.length > MAX_RELATIVE_PATH) die(`包内路径太长（${longest.length} > ${MAX_RELATIVE_PATH}）：${longest}`);
verifyForwarder();
const manifest = sealRuntime(APP, { platform: "win32" });
say(`✓ Windows x64 自带运行时 ${NODE_VERSION}：${native.length} 个原生文件全是 x64 PE，没有链接，@navi/shared 转发 ${forwarded} 个子路径，最长路径 ${longest.length}`);
say(`  ${APP}`);
say(`  清单 ${manifest.id}`);

function caseCollisions(root, prefix = "") {
  const seen = new Map();
  const found = [];
  for (const entry of readSync(root, prefix)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) found.push(`${seen.get(key)} ↔ ${path}`);
    seen.set(key, path);
    if (entry.isDirectory()) found.push(...caseCollisions(root, path));
  }
  return found;
}

function longestPath(root, prefix = "") {
  let longest = prefix;
  for (const entry of readSync(root, prefix)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const candidate = entry.isDirectory() ? longestPath(root, path) : path;
    if (candidate.length > longest.length) longest = candidate;
  }
  return longest;
}

function readSync(root, prefix) {
  return readdirSync(join(root, prefix), { withFileTypes: true });
}

// 转发包每个子路径导出的名字，必须和直接加载 shared 源码一模一样（`export *` 不带 default，有人加了默认导出这里会红）。
// 用本机的 node 加载：node.exe 在这儿跑不了，但模块解析与类型擦除不分平台。
function verifyForwarder() {
  if (!process.features.typescript) {
    say("  · 本机 node 不带类型擦除，跳过转发包的加载检查（Windows 上的冒烟会再验一遍）");
    return;
  }
  const shared = JSON.parse(readFileSync(join(APP, "shared/package.json"), "utf8"));
  const pairs = Object.entries(shared.exports).map(([subpath, target]) => [
    `@navi/shared${subpath.slice(1)}`, pathToFileURL(join(APP, "shared", target.default)).href]);
  const check = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const pairs = ${JSON.stringify(pairs)};
    for (const [name, direct] of pairs) {
      const viaPackage = Object.keys(await import(name)).sort().join(",");
      const viaSource = Object.keys(await import(direct)).sort().join(",");
      if (viaPackage !== viaSource) { console.error(name + " 导出不一致"); process.exit(3); }
      if (!import.meta.resolve(name).includes("/node_modules/@navi/shared/")) { console.error(name + " 没走转发包"); process.exit(4); }
    }
  `], { cwd: join(APP, "server"), encoding: "utf8" });
  if (check.status !== 0) die(`@navi/shared 转发包加载检查失败\n${check.stdout}${check.stderr}`);
}
