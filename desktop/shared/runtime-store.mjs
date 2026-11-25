// 自带运行时的内容清单与发布，mac 与 Windows 两边共用（mac 包把它拷成 app/scripts/runtime-store.mjs，
// Swift 壳从那里调；Windows 包同样带一份）。
//
// 清单有两种格式，按运行时要落到哪个系统上分：
//   format 1（mac）：文件记可执行位，允许包内相对链接（node_modules 里 @navi/* 的 workspace 软链）。
//   format 2（win32）：不记可执行位、不许任何链接。Windows 上 libuv 报的 mode 不带 x 位，在 mac 上
//     封出来的清单要在 Windows 上校验得过，就不能把它算进去；目标机建不出符号链接，junction 读回来是
//     绝对路径，所以包里一个链接都不能有（@navi/shared 换成转发包，见 desktop/windows/scripts/win-deps.mjs）。
// 封的时候定格式（sealRuntime 的 platform），校验按清单自己写的格式来；Windows 上只认 format 2。
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const manifestName = ".runtime.json";
const WINDOWS = process.platform === "win32";
const FORMATS = { 1: "darwin", 2: "win32" };

function inventory(root, platform, directory = "") {
  return readdirSync(join(root, directory)).sort().flatMap((name) => {
    const path = directory ? `${directory}/${name}` : name;
    if (path === manifestName || path === ".in-use") return [];
    const file = join(root, path);
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[path, "directory"], ...inventory(root, platform, path)];
    if (stat.isSymbolicLink() && platform === "win32") throw new Error(`Windows 运行时不能包含链接：${path}`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      const destination = relative(root, resolve(dirname(file), target));
      if (isAbsolute(target) || destination === ".." || destination.startsWith("../")) {
        throw new Error(`运行时链接越界：${path}`);
      }
      return [[path, "link", target]];
    }
    if (!stat.isFile()) throw new Error(`运行时包含特殊文件：${path}`);
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    return [platform === "win32" ? [path, "file", digest] : [path, "file", stat.mode & 0o111, digest]];
  });
}

function identifier(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function activateRuntime(store, id) {
  const launcher = join(store, `.mcp-${randomUUID()}`);
  const pointer = join(store, `.current-${randomUUID()}`);
  try {
    writeFileSync(launcher, `#!/bin/sh
set -eu
store=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd)
version=$(/usr/bin/readlink "$store/current")
case "$version" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "\${#version}" -eq 64 ] || exit 1
exec "$store/$version/node/bin/node" "$store/$version/mcp/dist/index.js" "$@"
`, { mode: 0o755 });
    renameSync(launcher, join(store, "mcp.sh"));
    symlinkSync(id, pointer);
    renameSync(pointer, join(store, "current"));
  } finally {
    rmSync(launcher, { force: true });
    rmSync(pointer, { force: true });
  }
}

/** platform：这份运行时要在哪个系统上跑（缺省是本机；在 mac 上组装 Windows 包时传 "win32"）。 */
export function sealRuntime(source, { platform = WINDOWS ? "win32" : "darwin" } = {}) {
  const format = Number(Object.keys(FORMATS).find((key) => FORMATS[key] === platform));
  if (!format) throw new Error(`不支持的运行时平台：${platform}`);
  const schema = inventory(source, platform).filter(([path]) => /^server\/dist\/db\/.*\.js$/.test(path));
  writeFileSync(join(source, ".handover.json"), JSON.stringify({ protocol: 1, schema: identifier(schema) }));
  const entries = inventory(source, platform);
  const manifest = format === 1 ? { format, id: identifier(entries), entries } : { format, platform, id: identifier(entries), entries };
  writeFileSync(join(source, manifestName), JSON.stringify(manifest));
  return manifest;
}

export function verifyRuntime(source, expectedID) {
  const lock = lstatSync(join(source, ".in-use"));
  if (!lock.isFile() || lock.size !== 0) throw new Error(`运行时代码锁损坏：${source}`);
  const manifest = JSON.parse(readFileSync(join(source, manifestName), "utf8"));
  const platform = FORMATS[manifest.format];
  if (!platform || (manifest.format !== 1 && manifest.platform !== platform) || (WINDOWS && platform !== "win32")
      || !/^[a-f0-9]{64}$/.test(manifest.id) || (expectedID && manifest.id !== expectedID)
      || identifier(manifest.entries) !== manifest.id || identifier(inventory(source, platform)) !== manifest.id) {
    throw new Error(`运行时校验失败：${source}`);
  }
  return manifest;
}

// Windows 上 current 指针和 MCP 启动器还没有（建不出符号链接，换成什么由壳那一侧定），只发布不激活。
export function installRuntime(source, store, { activate = !WINDOWS } = {}) {
  if (activate && WINDOWS) throw new Error("Windows 运行时只发布、不激活");
  const descriptor = process.platform === "darwin" ? openSync(join(source, ".in-use"), constants.O_RDONLY | 0x10) : null;
  try { return withStoreLock(store, () => publishRuntime(source, store, activate)); }
  finally { if (descriptor !== null) closeSync(descriptor); }
}

function withStoreLock(store, operation) {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const descriptor = openSync(join(store, ".store.lock"), constants.O_CREAT | constants.O_RDWR | (process.platform === "darwin" ? 0x20 : 0), 0o600);
  try { return operation(); } finally { closeSync(descriptor); }
}

export function selectRuntime(source, store) {
  return withStoreLock(store, () => {
    const root = realpathSync(source);
    if (dirname(root) !== realpathSync(store)) throw new Error("运行时不属于本数据根");
    const manifest = verifyRuntime(root);
    if (manifest.id !== basename(root)) throw new Error("运行时目录身份不符");
    activateRuntime(store, manifest.id);
  });
}

export function collectRuntimes(store) {
  if (process.platform !== "darwin") return [];
  return withStoreLock(store, () => {
    const pinned = new Set([readlinkSync(join(store, "current"))]);
    const journal = join(dirname(store), ".mac-runtime-recovery.json");
    if (existsSync(journal)) {
      try {
        const record = JSON.parse(readFileSync(journal, "utf8"));
        if (typeof record.previous !== "string" || typeof record.next !== "string") return [];
        for (const path of [record.previous, record.next]) pinned.add(path.split("/").at(-1));
      } catch { return []; }
    }
    const removed = [];
    for (const id of readdirSync(store).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      if (pinned.has(id)) continue;
      const root = join(store, id);
      if (lstatSync(root).isSymbolicLink()) continue;
      let descriptor;
      try {
        descriptor = openSync(join(root, ".in-use"), constants.O_RDONLY | constants.O_NONBLOCK | 0x20);
        verifyRuntime(root, id);
        const scan = spawnSync("/usr/sbin/lsof", ["-nP", "-w", "-t", "+D", root], { encoding: "utf8" });
        if (scan.error || ![0, 1].includes(scan.status) || scan.stderr.trim()
          || scan.stdout.trim().split(/\s+/).some((pid) => pid && Number(pid) !== process.pid)) continue;
        rmSync(root, { recursive: true });
        removed.push(id);
      } catch {}
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    return removed;
  });
}

function publishRuntime(source, store, activate) {
  const manifest = verifyRuntime(source);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const target = join(realpathSync(store), manifest.id);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`运行时目标不能是链接：${target}`);
    verifyRuntime(target, manifest.id);
    if (activate) activateRuntime(store, manifest.id);
    return target;
  }
  const stage = join(store, `.installing-${randomUUID()}`);
  try {
    cpSync(source, stage, { recursive: true, verbatimSymlinks: true });
    verifyRuntime(stage, manifest.id);
    try { renameInto(stage, target); }
    catch (error) {
      if (!existsSync(target) || lstatSync(target).isSymbolicLink()) throw error;
      verifyRuntime(target, manifest.id);
    }
    if (activate) activateRuntime(store, manifest.id);
    return target;
  } finally {
    rmSync(stage, { recursive: true, force: true, ...(WINDOWS ? { maxRetries: 10 } : {}) });
  }
}

// Windows 上刚拷完的文件常被杀毒、索引服务短暂开着，整目录改名会 EPERM/EBUSY；等它们放手再试
// （graceful-fs 对 rename 也是这么做的）。目标已经出现就不再试：那是别人先发布了同一份，交给调用方校验。
function renameInto(stage, target) {
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(stage, target); }
    catch (error) {
      if (!WINDOWS || existsSync(target) || attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, source, store] = process.argv.slice(2);
    if (operation === "seal" && source) console.log(sealRuntime(source, store ? { platform: store } : undefined).id);
    else if (operation === "install" && source && store) console.log(installRuntime(source, store));
    else if (operation === "stage" && source && store) console.log(installRuntime(source, store, { activate: false }));
    else if (operation === "activate" && source && store) selectRuntime(source, store);
    else if (operation === "gc" && source) console.log(JSON.stringify(collectRuntimes(source)));
    else throw new Error("usage: runtime-store.mjs seal <runtime> [win32] | install <runtime> <store> | stage <runtime> <store>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
