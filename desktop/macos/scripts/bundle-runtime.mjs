#!/usr/bin/env node
// 把「跑起一份 navi 要的一切」装进 Ash.app 的 Contents/Resources/app：固定版本的 node、shared/web/
// server/mcp 产物、生产依赖，以及按这份 node 重编的 node-pty。装完之后 app 不再依赖任何仓库检出，
// 也不依赖系统里有没有 node。
//
//   node desktop/macos/scripts/bundle-runtime.mjs <Resources 目录>
//
// 目录布局与仓库同形（server 认代码根 = server/dist 往上两级，见 server/src/data-root.ts）：
//
//   app/node/bin/node            自带运行时（只留这一个文件 + LICENSE，不带 npm）
//   app/package.json             workspaces 根，node_modules 里 @navi/* 的软链指回同级目录
//   app/node_modules/            server + mcp 的生产依赖
//   app/shared/{package.json,src}  shared 的导出直接指 .ts 源码，靠 node 的类型擦除跑 ——
//                                所以它必须在 node_modules **外面**（node 不擦 node_modules 里的 .ts）
//   app/server/{package.json,dist}
//   app/mcp/{package.json,dist}  navi MCP 的入口，首启接 MCP 时登记的就是它
//   app/web/dist
//   app/scripts/start-detached.mjs  app 起服务时让 server 进自己的会话
//   app/.in-use                  代码锁：跑这份代码的服务、MCP 以共享锁拿着它，换包时安装器拿排他锁
//                                （shared/src/code-lock.ts、scripts/install-app.sh）
//
// 下载的 node 包按写死在 architecture.mjs 的 sha256 校验，不认就不用（缓存里的也每次重验）。依赖按
// 「lockfile + 各 workspace 的 package.json + node 版本」缓存，没变就不再装一遍。和 Windows 包共用的
// 那几步在 desktop/shared/runtime-bundle.mjs。
//
// 环境变量：NAVI_MAC_SKIP_BUILD=1 跳过 `npm run build`（产物已是最新时省时间）；
//           NAVI_MAC_CACHE=<目录> 换缓存位置（缺省 desktop/macos/build/cache）。
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "../../../scripts/env.mjs";
import { sealRuntime } from "../../shared/runtime-store.mjs";
import { buildProducts, cachedDependencies, copyProducts, dependencyKey, die, fetchNode, run, say, unpackOnce } from "../../shared/runtime-bundle.mjs";
import { ARCHITECTURES, NODE_VERSION, buildArchitecture } from "./architecture.mjs";

const architecture = buildArchitecture();
const NODE_ARCHIVE = `node-${NODE_VERSION}-darwin-${architecture}.tar.xz`;
const NODE_SHA256 = ARCHITECTURES[architecture].checksum;

const HERE = dirname(fileURLToPath(import.meta.url));
const resources = process.argv[2];
if (!resources) {
  console.error("usage: bundle-runtime.mjs <Ash.app/Contents/Resources>");
  process.exit(2);
}
const CACHE = resolve(readEnv(process.env, "NAVI_MAC_CACHE") || join(HERE, "..", "build", "cache"));
const APP = join(resolve(resources), "app");

// ── 1. 产物 ────────────────────────────────────────────────────────────────
buildProducts({ skip: readEnv(process.env, "NAVI_MAC_SKIP_BUILD") === "1" });

// ── 2. node ────────────────────────────────────────────────────────────────
const archive = await fetchNode(CACHE, NODE_ARCHIVE, NODE_SHA256);
const nodeHome = unpackOnce(CACHE, NODE_ARCHIVE.replace(/\.tar\.xz$/, ""), "bin/node",
  (unpacking) => run("tar", ["-xJf", archive, "-C", unpacking, "--strip-components", "1"]));
const node = join(nodeHome, "bin", "node");
const npmCli = join(nodeHome, "lib", "node_modules", "npm", "bin", "npm-cli.js");

// ── 3. 生产依赖（node-pty 按这份 node 重编）──────────────────────────────
const deps = cachedDependencies(CACHE, dependencyKey(`${NODE_VERSION}\n${architecture}\nnode-pty: node-gyp --nodedir\n`), (stage) => {
  say("▶ 安装生产依赖，按自带 node 重编 node-pty");
  // npm 的生命周期脚本里写的是裸 `node`：让它们用的就是要打进包的这一份。
  const env = { ...process.env, PATH: `${join(nodeHome, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin` };
  run(node, [npmCli, "ci", "--omit=dev", "--workspace=@navi/server", "--workspace=@navi/mcp", "--no-audit", "--no-fund"], { cwd: stage, env });
  // node-pty 自带的预编译包先删掉：它的加载器找不到 build/Release 时会退回 prebuilds/，删了才
  // 保证跑起来的一定是下面这份。头文件取自同一个 node 包（--nodedir），不去网上另下一份。
  const pty = join(stage, "node_modules", "node-pty");
  rmSync(join(pty, "prebuilds"), { recursive: true, force: true });
  const gyp = join(nodeHome, "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  run(node, [gyp, "rebuild", `--nodedir=${nodeHome}`], { cwd: pty, env });
  run(node, [join(pty, "scripts", "post-install.js")], { cwd: pty, env });
  if (!existsSync(join(pty, "build", "Release", "pty.node"))) die("node-pty 没编出来（build/Release/pty.node 不存在）");
});

// ── 4. 装进 app ─────────────────────────────────────────────────────────────
say(`▶ 组装 ${APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, "node", "bin"), { recursive: true });
cpSync(node, join(APP, "node", "bin", "node"));
cpSync(join(nodeHome, "LICENSE"), join(APP, "node", "LICENSE"));
// -c：APFS 上是克隆，不占第二份空间；-R 原样保留 workspace 软链。
run("cp", ["-cR", join(deps, "node_modules"), join(APP, "node_modules")]);
copyProducts(APP);
// web 不进生产依赖，它那条 workspace 软链指向一个没有 package.json 的目录，留着只会让人误会。
rmSync(join(APP, "node_modules", "@navi", "web"), { force: true });

// ── 5. 自检：拿打进去的那份 node，从打进去的那份目录里加载 ──────────────────────
const smoke = spawnSync(join(APP, "node", "bin", "node"), ["--input-type=module", "-e", `
  await import("node:sqlite");
  if (process.arch !== ${JSON.stringify(architecture)}) process.exit(4);
  const pty = (await import("node-pty")).default;
  const mcp = await import("@navi/shared/mcp");
  if (!mcp.NAVI_MCP_SERVER_NAME || typeof pty.spawn !== "function") process.exit(3);
  console.log(process.version);
`], { cwd: join(APP, "server"), encoding: "utf8" });
if (smoke.status !== 0 || smoke.stdout.trim() !== NODE_VERSION) {
  die(`自检失败：自带的 node 加载不了 sqlite / node-pty / shared 源码\n${smoke.stdout}${smoke.stderr}`);
}
say(`✓ 自带运行时 ${NODE_VERSION}，产物与依赖已装进 ${APP}`);
sealRuntime(APP);
