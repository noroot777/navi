// 端口上应答的是谁 —— 起服务、窗口认人、`--start-server`、深链都只认这一份判据（对应 mac 的 NaviHealth.swift）。
//
// 「就绪」不能只看状态码：端口上随便一个回 200 的东西都会被当成服务好了。也不能只看「是不是 navi」：
// :4317 上完全可能是仓库里的开发实例，悄悄连上去，用户以为在用 app，数据其实写进了另一份库。所以本机地址
// 还要认它是不是本 app 起的那一份（`/api/health` 对本机直连会报 `instance`）：数据根是 app 的、代码是 app
// 自带的、报自己是 app 起的那一份（`desktop`）、在窗口专用端口上监听着，全对上才算。
//
// 认人只能回答「刚才那一刻是谁」。认过之后页面发的请求还带着那一份的实例号（cookie），端口换了人，新来的
// 那份见到别人的实例号就不执行（server/src/instance-binding.ts）。
import { request } from "node:http";
import { Agent } from "node:http";
import { publishedRuntime, samePath, storeContains } from "./config.mjs";

const DIRECT = new Agent({ keepAlive: false });

/**
 * 探一次 `<base>/api/health`。结果是下面四种之一：
 *   { kind: "down" }                     连接被拒，没人听这个端口
 *   { kind: "unreachable", reason }       发出去了却没等到答复：可能没人，也可能有人在、只是答不上来
 *   { kind: "notNavi", what }            有东西应答，但不是 navi
 *   { kind: "navi", instance }
 */
export function probe(base, { timeoutMs = 1500, path = "/api/health", headers } = {}) {
  const url = new URL(path, base);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = request(url, { method: "GET", agent: DIRECT, timeout: timeoutMs, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => done(classify(res.statusCode, body)));
      res.on("error", (error) => done({ kind: "unreachable", reason: error.message }));
    });
    req.on("timeout", () => { timedOut = true; req.destroy(); });
    req.on("error", (error) => {
      if (!timedOut && ["ECONNREFUSED", "EADDRNOTAVAIL"].includes(error.code)) return done({ kind: "down" });
      done({ kind: "unreachable", reason: timedOut ? "超时没有答复" : error.message });
    });
    req.on("close", () => done({ kind: "unreachable", reason: timedOut ? "超时没有答复" : "连接断了" }));
    req.end();
  });
}

export function classify(status, body) {
  let health;
  try { health = JSON.parse(body); } catch { /* 下面按不是 navi 算 */ }
  if (status !== 200 || !health || health.ok !== true) return { kind: "notNavi", what: `HTTP ${status}` };
  const instance = health.instance && typeof health.instance === "object" ? health.instance : {};
  const text = (value) => (typeof value === "string" ? value : null);
  const flag = (value) => (typeof value === "boolean" ? value : null);
  return {
    kind: "navi",
    instance: {
      pid: Number.isInteger(health.pid) ? health.pid : null,
      id: text(instance.id),
      dataDir: text(instance.dataDir),
      codeDir: text(instance.codeDir),
      localOnly: flag(instance.localOnly),
      desktop: flag(instance.desktop),
      tag: text(instance.tag),
      windowPort: Number.isInteger(instance.windowPort) ? instance.windowPort : null,
    },
  };
}

/** 哪一样对不上（说给用户听），全对上是 null。 */
export function mismatch(instance, cfg) {
  const { id, dataDir, codeDir, desktop, windowPort } = instance;
  if (!id || !dataDir || !codeDir || desktop === null) {
    return "它没报自己的实例号和代码、数据在哪（比这个 app 旧的版本），认不出来历。";
  }
  if (!samePath(dataDir, cfg.dataDir, cfg.windows)) return "它用的是另一份数据。";
  const published = publishedRuntime(cfg);
  if (!(published && samePath(codeDir, published, cfg.windows)) && !samePath(codeDir, cfg.bundledRuntime, cfg.windows)
      && !storeContains(cfg, codeDir)) {
    return "它用的是 app 的数据，跑的却不是 app 自带的代码。";
  }
  if (!desktop) return "它跑的是 app 自带的代码，但不是 app 起的那一份。";
  if (windowPort !== cfg.windowPort) {
    return `它没在 app 窗口的专用端口 ${cfg.windowPort} 上监听（那个端口多半被别的程序占着，或者它不是这个版本的 app 起的）。`;
  }
  return null;
}

export const isOurs = (instance, cfg) => mismatch(instance, cfg) === null;

/** 窗口能不能把页面载进来：本机地址必须是自己那份；连别处的 navi 时只要它是 navi。 */
export function isServing(result, cfg) {
  return result.kind === "navi" && (!cfg.isLocal || isOurs(result.instance, cfg));
}

/** 本机地址上认过的自己那一份；连别处的 navi、或者不是自己那份时是 null。 */
export function ours(result, cfg) {
  return cfg.isLocal && result.kind === "navi" && isOurs(result.instance, cfg) ? result.instance : null;
}
