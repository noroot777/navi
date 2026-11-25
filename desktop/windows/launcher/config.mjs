// Windows 壳连哪台、自带运行时在哪、数据和日志放哪（对应 mac 的 NaviConfig.swift）。
//
// 一切从 LOCALAPPDATA 派生（布局见 desktop/windows/scripts/layout.mjs）：验证时把 LOCALAPPDATA 换成临时目录，
// 设置、数据根、运行时仓库、网页数据（壳那一侧按同一个变量算，见 shell/src/paths.rs）就都跟日常那份分开。
// 几个环境变量是给验证用的口子：
//   NAVI_URL               连哪台（缺省 http://127.0.0.1:4317；换端口就写 http://127.0.0.1:14977）
//   NAVI_DATA_DIR          换数据根
//   NAVI_WIN_WINDOW_PORT   窗口专用端口（缺省按数据根算）
//   NAVI_WIN_RUNTIME       自带运行时在哪（缺省是本文件所在的那份运行时，见下）
// 壳拉起控制器时还会带上 NAVI_WIN_SHELL（壳自己的 exe，起服务时借它脱离 Job）和 NAVI_WIN_VERSION。
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// 本文件在运行时里的位置是 desktop/windows/launcher/，运行时根在往上三级（布局与仓库同形）。
const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadConfig(env = process.env, platform = process.platform) {
  const windows = platform === "win32";
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData)) throw new Error("LOCALAPPDATA 未设置或不是绝对路径");
  const home = join(localAppData, "Navi");
  const dataDir = env.NAVI_DATA_DIR ? resolve(env.NAVI_DATA_DIR) : join(home, "data");
  const baseURL = parseBase(env.NAVI_URL);
  const isLocal = LOOPBACK.has(baseURL.hostname.toLowerCase());
  const port = Number(baseURL.port || (baseURL.protocol === "https:" ? 443 : 80));
  const windowPort = portFrom(env.NAVI_WIN_WINDOW_PORT) ?? hashedPort(realPathish(dataDir, windows), windows);
  const bundledRuntime = env.NAVI_WIN_RUNTIME ? resolve(env.NAVI_WIN_RUNTIME) : BUNDLED;
  const logsDir = join(dataDir, "logs");
  return {
    windows,
    home,
    dataDir,
    logsDir,
    serverLog: join(logsDir, "server.log"),
    loginLog: join(logsDir, "login.log"),
    settingsFile: join(home, "settings.json"),
    runtimeStore: join(home, "runtimes"),
    bundledRuntime,
    nodeName: windows ? "node.exe" : "node",
    shellExe: env.NAVI_WIN_SHELL || null,
    version: env.NAVI_WIN_VERSION || "dev",
    baseURL: baseURL.origin,
    isLocal,
    port,
    windowPort,
    windowURL: isLocal ? `http://127.0.0.1:${windowPort}` : baseURL.origin,
    /** 数据根里有库才算用过（口径同 mac 的 DatabaseFile.isInitialized）。 */
    initializedMarkers: ["navi.db", "ash.db", "navi.db.renaming"].map((name) => join(dataDir, name)),
  };
}

function parseBase(raw) {
  for (const candidate of [raw?.trim(), "http://127.0.0.1:4317"]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol) && url.hostname) return url;
    } catch { /* 下一个 */ }
  }
  throw new Error("unreachable");
}

function portFrom(raw) {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

// 窗口专用端口：按数据根的真实路径算一个固定值（算法与 mac 的 NaviConfig.windowPort 相同：FNV-1a，落在
// 42000–47999，避开系统的临时端口段）。每次起服务都是同一个端口，页面存在本地的设置跟着这个地址留得住。
// Windows 的路径不分大小写，先折成小写再算，同一个目录换个写法不会换端口。
export function hashedPort(path, windows) {
  let hash = 2_166_136_261;
  for (const byte of Buffer.from(windows ? path.toLowerCase() : path, "utf8")) {
    hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
  }
  return 42_000 + (hash % 6_000);
}

/** 真实路径；还不存在的按最近一层存在的父目录解析再接上剩下的（数据根可能还没建）。 */
export function realPathish(path, windows = process.platform === "win32") {
  try { return windows ? realpathSync.native(path) : realpathSync(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPathish(parent, windows), basename(path));
  }
}

/** 两个路径是不是同一处：都按真实路径比，Windows 上不分大小写。 */
export function samePath(a, b, windows = process.platform === "win32") {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const fold = (path) => (windows ? realPathish(resolve(path), true).toLowerCase() : realPathish(resolve(path), false));
  return fold(a) === fold(b);
}

/** 这份运行时的内容清单 id（发布目录就叫这个名字）；没有或认不出是 null。 */
export function runtimeId(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ".runtime.json"), "utf8"));
    return manifest.format === 2 && /^[0-9a-f]{64}$/.test(manifest.id) ? manifest.id : null;
  } catch { return null; }
}

/** 自带运行时发布后落在哪（mac 的 RuntimeStore.destination）。 */
export function publishedRuntime(cfg) {
  const id = runtimeId(cfg.bundledRuntime);
  return id ? join(cfg.runtimeStore, id) : null;
}

/** 路径是不是运行时仓库里的某一份（新旧版本都算：换安装包后，旧版发布的服务也还是 app 起的那份）。 */
export function storeContains(cfg, path) {
  if (typeof path !== "string" || !path) return false;
  const id = basename(resolve(path));
  return runtimeId(path) === id && samePath(dirname(resolve(path)), cfg.runtimeStore, cfg.windows);
}
