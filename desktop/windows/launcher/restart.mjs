// 「现在重启服务会打断谁」与「只停评估过的那一份」（对应 mac 的 RestartImpact.swift、ServerControl.swift 的 ServerShutdown）。
//
// 问的是 server 的 `/api/restart-impact`，与 `npm run restart` 的安全闸同一条口径（判据在 server/src/reattach.ts）。
// 算「会打断」的两类：interrupted（重启后接不回来、会被判失败的）和 mcpDisrupted（进程活得过重启，但手里握着
// navi MCP，服务换代码那会儿交卷撞上就失败）。确认不了不等于没有：按会打断对待，只有用户点了才往下走。
//
// 停服务走 scripts/platform.mjs 的 killServerProcess —— 与 restart.mjs 同一条：Windows 上没有信号，整树结束、
// 但保住活得过重启的 agent 壳；POSIX 发 SIGTERM。停之前再认一遍端口上的还是不是评估过的那一个进程，换了人就不停。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killServerProcess } from "../../../scripts/platform.mjs";
import { isOurs, probe as probeHealth } from "./health.mjs";
import { isPidAlive } from "./maintenance.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 与 restart.mjs 同一张凭证：库的单例锁里那串 token。 */
export function hostToken(cfg) {
  for (const name of ["navi.db.navi.lock", "ash.db.ash.lock", "ash.db.navi.lock"]) {
    try {
      const token = JSON.parse(readFileSync(join(cfg.dataDir, name), "utf8")).token;
      if (typeof token === "string" && token) return token;
    } catch { /* 下一个 */ }
  }
  return null;
}

/** 同一个任务两类都占时只算一次（interrupted 优先：它说的后果更重）。 */
export function disruptedItems(impact) {
  const seen = new Set();
  const out = [];
  for (const item of impact.interrupted ?? []) {
    if (!seen.has(item.id)) { seen.add(item.id); out.push({ title: item.title, why: item.reason ? `会被判失败：${item.reason}` : "会被判失败" }); }
  }
  for (const item of impact.mcpDisrupted ?? []) {
    if (!seen.has(item.id)) { seen.add(item.id); out.push({ title: item.title, why: "手里握着 Navi MCP，服务重启那会儿交卷可能失败" }); }
  }
  return out;
}

/**
 * 问一次：{ kind: "clear" | "disrupts", target, items? } 或 { kind: "unknown", why }。
 * target：{ kind: "absent" } 没人在听 / { kind: "foreign" } 别的 navi / { kind: "remote" } 连的是别处 / { kind: "ours", pid }。
 */
export async function assessImpact(cfg, { probe = () => probeHealth(cfg.baseURL), ask = askImpact } = {}) {
  if (!cfg.isLocal) return { kind: "clear", target: { kind: "remote" } };
  const result = await probe();
  if (result.kind === "down") return { kind: "clear", target: { kind: "absent" } };
  if (result.kind === "unreachable") return { kind: "unknown", why: `服务没有答复：${result.reason}` };
  // 自己那份正忙、正在重启时也会这样（比如一次 503），不能当成「端口上不是 navi」。
  if (result.kind === "notNavi") return { kind: "unknown", why: `端口上的应答不像 Navi（${result.what}）` };
  if (!isOurs(result.instance, cfg)) {
    if (!result.instance.dataDir) return { kind: "unknown", why: "端口上的 Navi 没报数据根在哪，认不出是不是这一份" };
    return { kind: "clear", target: { kind: "foreign" } };
  }
  const { pid, id } = result.instance;
  if (!Number.isInteger(pid) || pid <= 1) return { kind: "unknown", why: "服务没报自己的进程号" };
  const target = { kind: "ours", pid };
  // 带着认过的那一份的实例号问：问到之前端口换了人，新来的那份不答（instance-binding.ts），闸拿不到别人的名单。
  const answer = await ask(cfg, id);
  if (answer.error) return { kind: "unknown", why: answer.error };
  const items = disruptedItems(answer.impact);
  return items.length ? { kind: "disrupts", target, items } : { kind: "clear", target };
}

async function askImpact(cfg, instanceId) {
  const token = hostToken(cfg);
  const headers = { ...(token ? { "x-navi-host-token": token } : {}), "x-navi-instance": instanceId };
  try {
    const response = await fetch(new URL("/api/restart-impact", cfg.baseURL), { headers, signal: AbortSignal.timeout(8_000) });
    if (response.status !== 200) return { error: `服务端回 ${response.status}` };
    const impact = await response.json();
    if (!Array.isArray(impact?.interrupted) || !Array.isArray(impact?.mcpDisrupted)) return { error: "答复看不懂（服务端版本太旧？）" };
    return { impact };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * 让自己那份服务下线：{ kind: "stopped" } / { kind: "changed", why }（端口上已经不是评估过的那一份了，没停任何东西）
 * / { kind: "failed", why }。target 为 null：用户在「确认不了」时仍然放行 —— 停那时候端口上自己那份，认不出是谁就不停。
 */
export async function stopServer(cfg, target, { probe = () => probeHealth(cfg.baseURL), kill = killServerProcess, alive = isPidAlive, timeoutMs = 20_000 } = {}) {
  if (target?.kind === "remote") return { kind: "stopped" };
  const result = await probe();
  if (result.kind === "down") return target?.kind === "ours" ? waitGone(cfg, target.pid, { probe, alive, timeoutMs }) : { kind: "stopped" };
  if (result.kind === "unreachable") return { kind: "changed", why: `服务这会儿没有答复（${result.reason}）` };
  if (result.kind === "notNavi") return { kind: "changed", why: `端口上的应答不像 Navi（${result.what}）` };
  if (!isOurs(result.instance, cfg)) {
    if (!result.instance.dataDir) return { kind: "changed", why: "端口上的 Navi 认不出是不是这一份" };
    return target?.kind === "ours" ? { kind: "changed", why: "端口上换成了别的 Navi" } : { kind: "stopped" };
  }
  const { pid } = result.instance;
  if (!Number.isInteger(pid) || pid <= 1) return { kind: "failed", why: "服务没报自己的进程号，没法让它下线。" };
  if (target && !(target.kind === "ours" && target.pid === pid)) return { kind: "changed", why: `服务换了一份（进程 ${pid}）` };
  try { kill(pid); }
  catch (error) { return { kind: "failed", why: `停不了服务进程 ${pid}：${error.message}` }; }
  return waitGone(cfg, pid, { probe, alive, timeoutMs });
}

async function waitGone(cfg, pid, { probe, alive, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid) && (await probe()).kind === "down") return { kind: "stopped", pid };
    await sleep(200);
  }
  return { kind: "failed", why: `服务进程 ${pid} ${Math.round(timeoutMs / 1000)} 秒内没有退出。看日志 ${cfg.serverLog}。` };
}
