// 组装自带运行时里和平台无关的那几步，mac（desktop/macos/scripts/bundle-runtime.mjs）与 Windows
// （desktop/windows/scripts/bundle-runtime.mjs）共用：固定版本 node 的下载校验、仓库产物、依赖缓存的键、
// 把产物按「与仓库同形」的布局拷进运行时目录。各平台自己只管 node 包的形状和原生依赖怎么来。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 两个平台用同一个 node 版本；各平台包的 sha256 写在各自的脚本里。
export const NODE_VERSION = "v26.13.1";
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKSPACES = ["shared", "server", "web", "mcp"];
// 依赖缓存的键由这些文件的内容决定：变了才重装。
export const DEPENDENCY_MANIFESTS = ["package.json", "package-lock.json", ...WORKSPACES.map((w) => `${w}/package.json`), "server/scripts/prepare-node-pty.mjs"];
// 运行时里与仓库同形的那部分（server 认代码根 = server/dist 往上两级，见 server/src/data-root.ts）。
const PRODUCT_COPIES = [
  "shared/package.json", "shared/src",
  "server/package.json", "server/dist",
  "mcp/package.json", "mcp/dist",
  "web/dist",
  "scripts/start-detached.mjs",
];

export const say = (line) => process.stdout.write(`${line}\n`);
export const die = (line) => { process.stderr.write(`✕ ${line}\n`); process.exit(1); };

export function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) die(`${command} ${args.join(" ")} 失败（退出码 ${result.status ?? result.signal}）`);
}

export async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function buildProducts({ skip }) {
  if (!skip) {
    say("▶ npm run build");
    run("npm", ["run", "build"], { cwd: REPO, shell: process.platform === "win32" });
  }
  for (const built of ["server/dist/index.js", "mcp/dist/index.js", "web/dist/index.html", "shared/src/index.ts"]) {
    if (!existsSync(join(REPO, built))) die(`${built} 不存在：先在仓库根跑一次 npm run build`);
  }
}

/** 下载 nodejs.org 上的 `name` 到缓存，按写死的 sha256 校验；缓存里的也每次重验，不认就不用。 */
export async function fetchNode(cache, name, sha256) {
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, name);
  if (existsSync(archive) && (await sha256Of(archive)) === sha256) return archive;
  say(`▶ 下载 ${name}`);
  const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${name}`);
  if (!response.ok) die(`下载 node 失败：HTTP ${response.status}`);
  const partial = `${archive}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256Of(partial);
  if (actual !== sha256) {
    rmSync(partial, { force: true });
    die(`${name} 的 sha256 对不上：期望 ${sha256}，实际 ${actual}`);
  }
  renameSync(partial, archive);
  return archive;
}

/** 解到 `<cache>/<home>`：先解进旁边的目录再改名，半截的解压不会被当成好的。 */
export function unpackOnce(cache, home, marker, unpack) {
  const target = join(cache, home);
  if (existsSync(join(target, marker))) return target;
  const unpacking = `${target}.unpacking`;
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(unpacking);
  unpack(unpacking);
  if (!existsSync(join(unpacking, marker))) die(`${home} 解出来没有 ${marker}`);
  rmSync(target, { recursive: true, force: true });
  renameSync(unpacking, target);
  return target;
}

/** 依赖缓存的键：`header` 写清这份依赖跟哪个 node、哪种原生依赖做法绑着，再加上各份清单的内容。 */
export function dependencyKey(header) {
  return createHash("sha256")
    .update(header)
    .update(DEPENDENCY_MANIFESTS.map((m) => `${m}\n${readFileSync(join(REPO, m), "utf8")}`).join("\n"))
    .digest("hex").slice(0, 16);
}

/** 在 `<cache>/deps-<key>` 里备好 node_modules：没有就把清单拷进暂存目录交给 install，装好再改名。 */
export function cachedDependencies(cache, key, install) {
  const deps = join(cache, `deps-${key}`);
  if (existsSync(join(deps, "node_modules"))) return deps;
  const stage = `${deps}.installing`;
  rmSync(stage, { recursive: true, force: true });
  for (const m of DEPENDENCY_MANIFESTS) {
    mkdirSync(dirname(join(stage, m)), { recursive: true });
    cpSync(join(REPO, m), join(stage, m));
  }
  install(stage);
  rmSync(deps, { recursive: true, force: true });
  renameSync(stage, deps);
  return deps;
}

/** 把仓库产物、运行时仓库脚本和代码锁文件装进运行时目录（node 与 node_modules 由各平台自己放）。 */
export function copyProducts(app) {
  cpSync(join(REPO, "package.json"), join(app, "package.json"));
  for (const rel of PRODUCT_COPIES) cpSync(join(REPO, rel), join(app, rel), { recursive: true, verbatimSymlinks: true });
  cpSync(join(REPO, "desktop/shared/runtime-store.mjs"), join(app, "scripts/runtime-store.mjs"));
  writeFileSync(join(app, ".in-use"), "");
}
