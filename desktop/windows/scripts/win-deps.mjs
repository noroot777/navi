// Windows x64 的生产依赖：在任何一台机器上（包括 mac 开发机）都装得出来，不编译任何东西。
//
// · 按 win32-x64 装：npm 的 --os/--cpu 让平台相关的可选依赖按目标机挑；--ignore-scripts 不跑生命周期脚本 ——
//   它们会按**装依赖的这台机器**去判断（node-pty 的 install 在 mac 上会去认 darwin 的预编译包），而 Windows 上
//   这些脚本本来也什么都不产出：node-pty 走它自带的 prebuilds/win32-x64（含 conpty.node 与 conpty/ 下的
//   conpty.dll、OpenConsole.exe），server 的 postinstall 在 win32 上是空操作（server/scripts/prepare-node-pty.mjs）。
// · node-pty 只留 prebuilds/win32-x64：别的平台的预编译包、third_party 里供源码编译用的两份 conpty、调试符号都删掉。
// · --no-bin-links：不建 node_modules/.bin（在 POSIX 上它们是符号链接，运行时也用不着）。
// · @navi/* 不能是链接：目标机建不出符号链接；junction 要在目标机上现建、而且读回来是绝对路径，
//   内容清单、安装包、运行时发布这一路都得为它开口子。所以 workspace 链接全部删掉，@navi/shared 换成一个
//   **转发包**：node_modules/@navi/shared 下每个导出子路径一个 .js，只有一行 `export * from` 指回
//   ../../../shared/src/<名>.ts。shared 的导出直接指 .ts 源码、靠 node 的类型擦除跑，而 node 不擦
//   node_modules 里的 .ts —— 转发包本身是 .js，真正的 .ts 仍在 node_modules 外面，所以照样能跑；
//   模块实例也只有一份（指向的是同一个文件）。@navi/server、@navi/mcp、@navi/web 没人按包名引用，删掉即可。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { die, run } from "../../shared/runtime-bundle.mjs";

export const WINDOWS_TARGET = { os: "win32", cpu: "x64" };

/** 在 stage（已备好清单）里装依赖。npm 取自那份 win-x64 node 包（版本跟着 node 走），由本机 node 来跑。 */
export function installWindowsDependencies(stage, npmCli) {
  run(process.execPath, [npmCli, "ci", "--omit=dev", "--workspace=@navi/server", "--workspace=@navi/mcp",
    `--os=${WINDOWS_TARGET.os}`, `--cpu=${WINDOWS_TARGET.cpu}`, "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"], { cwd: stage });
  const modules = join(stage, "node_modules");
  pruneNodePty(join(modules, "node-pty"));
  rmSync(join(modules, "@navi"), { recursive: true, force: true });
  const links = findLinks(modules);
  if (links.length) die(`Windows 依赖里还有链接：\n  ${links.slice(0, 20).join("\n  ")}`);
}

function pruneNodePty(pty) {
  const prebuilds = join(pty, "prebuilds");
  const target = `${WINDOWS_TARGET.os}-${WINDOWS_TARGET.cpu}`;
  if (!existsSync(join(prebuilds, target, "conpty.node")) || !existsSync(join(prebuilds, target, "conpty", "conpty.dll"))) {
    die(`node-pty 没带 ${target} 的 ConPTY 预编译包（prebuilds/${target}/conpty.node、conpty/conpty.dll）`);
  }
  for (const name of readdirSync(prebuilds)) if (name !== target) rmSync(join(prebuilds, name), { recursive: true, force: true });
  for (const name of readdirSync(join(prebuilds, target))) if (name.endsWith(".pdb")) rmSync(join(prebuilds, target, name));
  rmSync(join(pty, "third_party"), { recursive: true, force: true });
  rmSync(join(pty, "build"), { recursive: true, force: true });
}

export function findLinks(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) return [path];
    return entry.isDirectory() ? findLinks(root, path) : [];
  });
}

/** 按 shared/package.json 的 exports 生成转发包，写到 `<modules>/@navi/shared`；返回生成的子路径数。 */
export function writeSharedForwarder(modules, sharedPackageFile) {
  const shared = JSON.parse(readFileSync(sharedPackageFile, "utf8"));
  const forwarder = join(modules, "@navi", "shared");
  rmSync(forwarder, { recursive: true, force: true });
  const exportsMap = {};
  for (const [subpath, target] of Object.entries(shared.exports)) {
    const source = typeof target === "string" ? target : target.default;
    if (!/^\.\/src\/[\w./-]+\.ts$/.test(source ?? "") || subpath.includes("*")) die(`shared 的导出 ${subpath} 不是指向 src 下 .ts 的普通子路径，转发包接不住`);
    const file = `${subpath === "." ? "index" : subpath.slice(2)}.js`;
    const from = posix.relative(posix.dirname(`node_modules/@navi/shared/${file}`), `shared/${source.slice(2)}`);
    mkdirSync(dirname(join(forwarder, file)), { recursive: true });
    writeFileSync(join(forwarder, file), `export * from ${JSON.stringify(from)};\n`);
    exportsMap[subpath] = `./${file}`;
  }
  writeFileSync(join(forwarder, "package.json"), `${JSON.stringify({
    name: shared.name, version: shared.version, private: true, type: "module",
    description: "转发到 ../../../shared/src 的 TypeScript 源码（desktop/windows/scripts/win-deps.mjs）", exports: exportsMap,
  }, null, 2)}\n`);
  if (lstatSync(forwarder).isSymbolicLink()) die("转发包不该是链接");
  return Object.keys(exportsMap).length;
}
