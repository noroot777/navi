// 栈帧出处（`CodeLocations`，见 @navi/shared/runtime-log 的 verifyFrames）：位置是不是磁盘上真有的 navi 代码，
// 这一帧叫什么名字。
//
// **名字从可信的一侧读出来，不回显上报的那一份**（第 3 轮审查：旧版核对「这个词在代码文件里出现过」，
// 注释、界面文案里的 `OpenAI` 就带了出去）：
//   · navi 自己的代码文件：从那一行往上找包住它的函数声明（`function f(`、`const f = (…) =>`、方法 `f(…) {`），
//     大括号配对确认它真的包住这一行。读出来的是代码文本里的声明名，跟运行时这个函数被叫成什么无关；
//     找不到（匿名回调、压缩过的产物）就只留位置；
//   · Node 内置模块：只认它公开导出的名字，封闭集合；内部模块、依赖包不给名字。
//
// 两套代码根：服务端 `server/ shared/ mcp/` 底下的文件、Node 内置、依赖包；页面是 web 产物（`web/dist/…`）
// 和开发时 vite 直接给的源码（`web/src/…`）。只在出了卡顿 / 报错要记栈时用，不在热路径上。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, normalize, sep } from "node:path";
import type { CodeLocations } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";

/** 读进来的代码文件上限：再大的不是 navi 的代码。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CACHED = 64;
/** 往上最多找这么多行；一行超过这么长的（压缩产物）不读名字。 */
const SCAN_LINES = 80;
const MAX_LINE = 400;

const files = new Map<string, string[] | null>();

function linesOf(file: string): string[] | null {
  if (files.has(file)) return files.get(file)!;
  let lines: string[] | null = null;
  try {
    if (statSync(file).size <= MAX_FILE_BYTES) lines = readFileSync(file, "utf8").split("\n");
  } catch {
    lines = null;
  }
  if (files.size >= MAX_CACHED) files.delete(files.keys().next().value!);
  files.set(file, lines);
  return lines;
}

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try", "await", "typeof"]);
const DECLARATIONS = [
  /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*[<(]/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:(?:public|private|protected|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::[^{]+)?\{/,
];

function declaredName(text: string): string | null {
  for (const pattern of DECLARATIONS) {
    const name = pattern.exec(text)?.[1];
    if (name && !NOT_NAMES.has(name)) return name;
  }
  return null;
}

const count = (text: string, char: string) => text.split(char).length - 1;

/** 包住第 `line` 行（1 起）的函数声明名。 */
function enclosingFunction(file: string, line: number | null): string | null {
  const lines = line ? linesOf(file) : null;
  if (!lines || !line || line > lines.length) return null;
  const own = lines[line - 1]!;
  if (own.length > MAX_LINE) return null;
  const same = declaredName(own);
  if (same) return same;
  // 往上走：大括号净开着（`{` 比 `}` 多）的那一行才包住目标行。
  let depth = 0;
  for (let i = line - 2; i >= 0 && i >= line - 1 - SCAN_LINES; i -= 1) {
    const text = lines[i]!;
    if (text.length > MAX_LINE) return null;
    depth += count(text, "}") - count(text, "{");
    if (depth < 0) {
      const name = declaredName(text);
      if (name) return name;
      depth = 0;
    }
  }
  return null;
}

/** `rel` 落在 `root` 底下的这几个子目录之一，返回绝对路径；跳出去的（`..`）不认。 */
function inside(root: string, dirs: readonly string[], rel: string): string | null {
  if (!/^[\w./@-]{1,160}$/.test(rel) || !dirs.some((dir) => rel.startsWith(`${dir}/`))) return null;
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
  exists(file) {
    if (file.startsWith("node:")) return builtinId(file) !== null;
    if (file.startsWith("node_modules/")) {
      const target = inside(CODE_DIR, ["node_modules"], file);
      return target !== null && existsSync(target);
    }
    const target = serverFile(file);
    return target !== null && linesOf(target) !== null;
  },
  nameAt(file, line, reported) {
    if (file.startsWith("node:")) return builtinName(file, reported);
    const target = file.startsWith("node_modules/") ? null : serverFile(file);
    return target ? enclosingFunction(target, line) : null;
  },
};

const WEB_DIR = join(CODE_DIR, "web");

/** 产物里的 `assets/index-abc.js`；开发服务直接给源码时是 `src/lib/x.ts`。 */
function webFile(file: string): { target: string; source: boolean } | null {
  const built = inside(join(WEB_DIR, "dist"), ["assets"], file);
  if (built) return { target: built, source: false };
  const source = inside(WEB_DIR, ["src"], file);
  return source ? { target: source, source: true } : null;
}

export const webCodeLocations: CodeLocations = {
  exists(file) {
    const found = webFile(file);
    return found !== null && linesOf(found.target) !== null;
  },
  // 打包产物压成了一行，读不出名字；只有开发时的源码能按行找。
  nameAt(file, line) {
    const found = webFile(file);
    return found?.source ? enclosingFunction(found.target, line) : null;
  },
};

/** 页面生成的标识换成摘要：只拿来判断「是不是同一个」，原值不落盘。 */
export function digestPageId(id: string): string {
  return createHash("sha256").update(`navi-runtime-log:${id}`).digest("hex").slice(0, 12);
}
