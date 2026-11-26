// 栈帧出处（`CodeLocations`，见 @navi/shared/runtime-log 的 verifyFrames）：位置是不是磁盘上真有的 navi 代码
// （是就交回核对过的那个规范写法），这一帧能不能带名字。
//
// **日志里不存函数名**，只存核对过的代码位置（文件:行[:列]），拿到日志的人对着代码看那一行就知道是哪个函数。
// 唯一带名字的是 Node 内置模块的公开导出（`execFileSync node:child_process`）：那是一份封闭名单，跟错误名一样。
// 前三轮审查一路证明「上报的名字可信」都没收住——文件存在不够、词在代码里出现过不够（注释、界面文案里什么词都有），
// 从源码按行推所在函数又会张冠李戴；名字本来就是可以被运行时改写、被页面随便填的东西，所以干脆不收。
//
// 两套代码根：服务端 `server/ shared/ mcp/` 底下的文件、Node 内置、依赖包；页面是 web 产物（`web/dist/…`）
// 和开发时 vite 直接给的源码（`web/src/…`）。只在出了卡顿 / 报错要记栈时用，不在热路径上。
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, normalize, sep } from "node:path";
import type { CodeLocations } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";

/** 再大的不是 navi 的代码。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function isCodeFile(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/**
 * `rel` 落在 `root` 底下的这几个子目录之一，返回绝对路径。只认规范写法：带 `.` / `..` / 空段的一律不认——
 * 规范化之后存在不代表原串可信，`src/客户名/../lib/x.ts` 规范化掉的那一段可以是任何东西。
 */
function inside(root: string, dirs: readonly string[], rel: string): string | null {
  if (!/^[\w./@-]{1,160}$/.test(rel) || !dirs.some((dir) => rel.startsWith(`${dir}/`))) return null;
  if (rel.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const target = normalize(join(root, rel));
  return dirs.some((dir) => target.startsWith(join(root, dir) + sep)) ? target : null;
}

const require = createRequire(import.meta.url);
const builtinExports = new Map<string, Set<string>>();

function builtinId(file: string): string | null {
  const id = file.slice("node:".length);
  return id === "internal" || builtinModules.includes(id) ? id : null;
}

function builtinName(file: string, reported: string): string | null {
  const id = builtinId(file);
  if (!id || id === "internal") return null;
  let names = builtinExports.get(id);
  if (!names) {
    try {
      names = new Set(Object.keys(require(`node:${id}`) as object));
    } catch {
      names = new Set();
    }
    builtinExports.set(id, names);
  }
  return names.has(reported) ? reported : null;
}

function serverFile(file: string): string | null {
  const target = inside(CODE_DIR, ["server", "shared", "mcp"], file);
  return target && !target.includes(`${sep}node_modules${sep}`) ? target : null;
}

export const serverCodeLocations: CodeLocations = {
  resolve(file) {
    if (file.startsWith("node:")) {
      const id = builtinId(file);
      return id === null ? null : `node:${id}`;
    }
    if (file.startsWith("node_modules/")) {
      const target = inside(CODE_DIR, ["node_modules"], file);
      return target !== null && existsSync(target) ? file : null;
    }
    const target = serverFile(file);
    return target !== null && isCodeFile(target) ? file : null;
  },
  nameAt(file, _line, reported) {
    return file.startsWith("node:") ? builtinName(file, reported) : null;
  },
};

const WEB_DIR = join(CODE_DIR, "web");

/** 产物里的 `assets/index-abc.js`；开发服务直接给源码时是 `src/lib/x.ts`。 */
function webFile(file: string): string | null {
  return inside(join(WEB_DIR, "dist"), ["assets"], file) ?? inside(WEB_DIR, ["src"], file);
}

export const webCodeLocations: CodeLocations = {
  resolve(file) {
    const target = webFile(file);
    return target !== null && isCodeFile(target) ? file : null;
  },
  // 页面报上来的名字一个都不收（页面没有 Node 内置模块）。
  nameAt: () => null,
};

/** 页面生成的标识换成摘要：只拿来判断「是不是同一个」，原值不落盘。 */
export function digestPageId(id: string): string {
  return createHash("sha256").update(`navi-runtime-log:${id}`).digest("hex").slice(0, 12);
}
