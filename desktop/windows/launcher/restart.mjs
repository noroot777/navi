// 「现在重启服务会打断谁」与「只停评估过的那一份」（对应 mac 的 RestartImpact.swift、ServerControl.swift 的 ServerShutdown）。
//
// 问的是 server 的 `/api/restart-impact`，与 `npm run restart` 的安全闸同一条口径（判据在 server/src/reattach.ts）。
// 算「会打断」的两类：interrupted（重启后接不回来、会被判失败的）和 mcpDisrupted（进程活得过重启，但手里握着
// navi MCP，服务换代码那会儿交卷撞上就失败）。确认不了不等于没有：按会打断对待，只有用户点了才往下走。
//
// 停服务走 scripts/platform.mjs 的 killServerProcess —— 与 restart.mjs 同一条：Windows 上没有信号，整树结束、
// 但保住活得过重启的 agent 壳；POSIX 发 SIGTERM。停之前再认一遍端口上的还是不是评估过的那一个进程，换了人就不停。
//
// 用户点头之后先让服务冻结接活（freezeImpact，协议在 scripts/restart-freeze.mjs），拿冻结之下的快照跟他同意过的
// 那份比；冻着的时候影响不会再变多，停之前续一次期、确认冻结还在才下刀。老版本服务没有这道关口时退回即时评估。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killServerProcess } from "../../../scripts/platform.mjs";
import {
  RESTART_FREEZE_PATH, acquireRestartFreeze, releaseRestartFreeze, renewRestartFreeze, supportsRestartFreeze,
} from "../../../scripts/restart-freeze.mjs";
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

/**
 * 同一个任务两类都占时只算一次（interrupted 优先：它说的后果更重）。另加随服务一起关掉的终端、聊天、AI 协助、
 * 预览试跑（shutdown.resources，问的时候带 ?shutdown=1；老版本服务不给就没有这一类）。
 */
export function disruptedItems(impact) {
  const seen = new Set();
  const out = [];
  for (const item of impact.interrupted ?? []) {
    if (!seen.has(item.id)) { seen.add(item.id); out.push({ id: item.id, title: item.title, why: item.reason ? `会被判失败：${item.reason}` : "会被判失败" }); }
  }
  for (const item of impact.mcpDisrupted ?? []) {
    if (!seen.has(item.id)) { seen.add(item.id); out.push({ id: item.id, title: item.title, why: "手里握着 Navi MCP，服务重启那会儿交卷可能失败" }); }
  }
  const resources = impact.shutdown?.resources;
  for (const resource of Array.isArray(resources) ? resources : []) {
    out.push({ id: `${resource.kind}:${resource.id}`, title: resource.label || resource.kind, why: "会随服务一起关掉" });
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
  return verdictOf(target, id, answer.impact);
}

/** 一份影响名单 → 判断。`instance` 与 `freezable` 是给冻结那一步用的：认的是哪一份、它认不认冻结。 */
function verdictOf(target, instance, impact) {
  const items = disruptedItems(impact);
  const extra = { instance, freezable: supportsRestartFreeze(impact) };
  return items.length ? { kind: "disrupts", target, items, ...extra } : { kind: "clear", target, ...extra };
}

/**
 * 点头之后、停服务之前：先冻结接活，再拿冻结之下的那份判断。
 *  · `{ kind: "frozen", lease, verdict }`  冻住了；verdict 与 assessImpact 同形，停下之前它不会再变多
 *  · `{ kind: "unfrozen", verdict }`       服务不认这道关口（老版本）、或者端口上不是自己那份：verdict 是即时再评估的
 *  · `{ kind: "refused", why }`            认这道关口却冻不了：另一处正在准备重启、没有权限、没答上来 —— 不停
 */
export async function freezeImpact(cfg, { assess = () => assessImpact(cfg), send = freezeSender } = {}) {
  const now = await assess();
  if (now.target?.kind !== "ours" || !now.freezable) return { kind: "unfrozen", verdict: now };
  const transport = send(cfg, now.instance);
  const got = await acquireRestartFreeze(transport);
  if (got.kind !== "frozen") return { kind: "refused", why: got.why };
  // 冻住的必须是刚认过的那一份：问到之前端口换了人的话，新来的那份不答（instance-binding.ts），这里是兜底。
  if (got.instance !== now.instance || got.pid !== now.target.pid) {
    await releaseRestartFreeze(transport, got.lease);
    return { kind: "unfrozen", verdict: { kind: "unknown", why: "冻结时端口上换了一份服务" } };
  }
  return { kind: "frozen", lease: { send: transport, token: got.lease }, verdict: verdictOf(now.target, now.instance, got.impact) };
}

/**
 * 下刀之前续一次期：冻结还在、此刻的名单也没比 `agreed`（用户点头的那份判断）多出谁，就是 null；否则交回原因。
 * 名单会多是因为已经在跑的 agent 中途拉起 navi MCP 这件事服务端冻不住（见 scripts/restart-freeze.mjs）。
 */
export async function renewFreeze(lease, agreed) {
  const renewed = await renewRestartFreeze(lease.send, lease.token);
  if (!renewed.valid) return renewed.why;
  if (!agreed || agreed.target?.kind !== "ours") return null;
  const now = verdictOf(agreed.target, agreed.instance, renewed.impact);
  if (!widened(agreed, now)) return null;
  const known = new Set((agreed.items ?? []).map((item) => item.id ?? item.title));
  const extra = now.items.filter((item) => !known.has(item.id ?? item.title)).map((item) => item.title);
  return `确认之后又多了会被打断的：${extra.slice(0, 5).join("、")}${extra.length > 5 ? ` 等 ${extra.length} 项` : ""}`;
}

export function releaseFreeze(lease) {
  return releaseRestartFreeze(lease.send, lease.token);
}

function freezeSender(cfg, instanceId) {
  const token = hostToken(cfg);
  const headers = { "content-type": "application/json", ...(token ? { "x-navi-host-token": token } : {}), "x-navi-instance": instanceId };
  return async (body) => {
    try {
      const response = await fetch(new URL(RESTART_FREEZE_PATH, cfg.baseURL), {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => null);
      return { status: response.status, data, error: null };
    } catch (error) {
      return { status: null, data: null, error: error.message };
    }
  };
}

/**
 * 用户点头之后再评估一次，比点头时摆给他看的那一份多出了什么：多出了会打断的任务、从确认得了变成确认不了、
 * 端口上换了一份服务 —— 这些都是他没同意过的，要重新问。名单变短、照旧不算。
 */
export function widened(agreed, now) {
  if (now.kind === "unknown") return agreed.kind !== "unknown";
  const target = (verdict) => (verdict.target?.kind === "ours" ? `ours:${verdict.target.pid}` : verdict.target?.kind ?? null);
  if (agreed.kind !== "unknown" && target(agreed) !== target(now)) return true;
  if (now.kind !== "disrupts") return false;
  if (agreed.kind === "unknown") return false;
  const known = new Set((agreed.items ?? []).map((item) => item.id ?? item.title));
  return now.items.some((item) => !known.has(item.id ?? item.title));
}

async function askImpact(cfg, instanceId) {
  const token = hostToken(cfg);
  const headers = { ...(token ? { "x-navi-host-token": token } : {}), "x-navi-instance": instanceId };
  try {
    const response = await fetch(new URL("/api/restart-impact?shutdown=1", cfg.baseURL), { headers, signal: AbortSignal.timeout(8_000) });
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
 * beforeKill：认完人、下刀之前最后问一句，交回原因就不停（冻结续期没续上，见 renewFreeze）。
 */
export async function stopServer(cfg, target, { probe = () => probeHealth(cfg.baseURL), kill = killServerProcess, alive = isPidAlive, timeoutMs = 20_000, beforeKill = async () => null } = {}) {
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
  const refused = await beforeKill();
  if (refused) return { kind: "changed", why: refused };
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
