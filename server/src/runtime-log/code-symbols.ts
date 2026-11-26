// 栈帧出处核对（`CodeSymbols`，见 @navi/shared/runtime-log 的 verifyFrames）：位置是不是磁盘上真有的
// navi 代码，名字是不是那份代码里写着的标识符。
//
// 服务端自己的栈和页面报上来的栈走两套代码根：
//   · 服务端：`server/ shared/ mcp/` 底下的文件（相对代码根）、Node 内置模块的公开导出、装着的依赖包（只认包在，
//     不认名字——依赖的源码不一份份读）；
//   · 页面：web 产物（`web/dist/…`），开发时 vite 直接给的源码（`web/src/…`）。
// 一份文件的标识符读一次缓存起来；只在出了卡顿 / 报错要记栈的时候才用，不在热路径上。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, normalize, sep } from "node:path";
import type { CodeSymbols } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";

/** 读进来的代码文件上限：再大的不是 navi 的代码。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CACHED = 64;

const tokens = new Map<string, Set<string> | null>();

function tokensOf(file: string): Set<string> | null {
  if (tokens.has(file)) return tokens.get(file)!;
  let found: Set<string> | null = null;
  try {
    if (statSync(file).size <= MAX_FILE_BYTES) found = new Set(readFileSync(file, "utf8").match(/[A-Za-z_$][\w$]*/g) ?? []);
  } catch {
    found = null;
  }
  if (tokens.size >= MAX_CACHED) tokens.delete(tokens.keys().next().value!);
  tokens.set(file, found);
  return found;
}

/** `rel` 落在 `root` 底下的这几个子目录之一，返回绝对路径；跳出去的（`..`）不认。 */
function inside(root: string, dirs: readonly string[], rel: string): string | null {
  if (!/^[\w./@-]{1,160}$/.test(rel) || !dirs.some((dir) => rel.startsWith(`${dir}/`))) return null;
  const target = normalize(join(root, rel));
  return dirs.some((dir) => target.startsWith(join(root, dir) + sep)) ? target : null;
}

const require = createRequire(import.meta.url);
const builtinExports = new Map<string, Set<string>>();

function builtin(file: string, name: string | null): boolean {
  const id = file.slice("node:".length);
  if (id === "internal") return name === null;
  if (!builtinModules.includes(id)) return false;
  if (name === null) return true;
  let names = builtinExports.get(id);
  if (!names) {
    try {
      names = new Set(Object.keys(require(`node:${id}`) as object));
    } catch {
      names = new Set();
    }
    builtinExports.set(id, names);
  }
  return names.has(name);
}

export const serverCodeSymbols: CodeSymbols = (file, name) => {
  if (file.startsWith("node:")) return builtin(file, name);
  if (file.startsWith("node_modules/")) {
    const target = inside(CODE_DIR, ["node_modules"], file);
    return name === null && target !== null && existsSync(target);
  }
  const target = inside(CODE_DIR, ["server", "shared", "mcp"], file);
  if (!target || target.includes(`${sep}node_modules${sep}`)) return false;
  const found = tokensOf(target);
  return found !== null && (name === null || found.has(name));
};

const WEB_DIR = join(CODE_DIR, "web");

export const webCodeSymbols: CodeSymbols = (file, name) => {
  // 产物里的 `assets/index-abc.js`；开发服务直接给源码时是 `src/lib/x.ts`。
  const target = inside(join(WEB_DIR, "dist"), ["assets"], file) ?? inside(WEB_DIR, ["src"], file);
  const found = target ? tokensOf(target) : null;
  return found !== null && (name === null || found.has(name));
};

/** 页面生成的标识换成摘要：只拿来判断「是不是同一个」，原值不落盘。 */
export function digestPageId(id: string): string {
  return createHash("sha256").update(`navi-runtime-log:${id}`).digest("hex").slice(0, 12);
}
