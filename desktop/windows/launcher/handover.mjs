// 装了新版之后把服务换到新运行时上（对应 mac 的 UpdateGate 里 preservingRuntime 那一段，README「装之前那道闸」）。
//
// 更新只换安装目录里的壳和运行时发布源，服务还在 %LOCALAPPDATA%\Navi\runtimes\<旧 id>\ 里跑、agent 也照常跑。
// 新壳一认出端口上是自己那份、跑的却是旧运行时，就在这里每 5 秒问一次旧服务「现在能不能无损交接」：
//   · /api/restart-impact?protocol=&schema=&shutdown=1：runtimeHandover.blocked 是新版接不住的回合（排队中、
//     调度台回合、agent 进程不对等），shutdown.resources 是旧服务一停就跟着没的东西（终端、项目服务、预览）。
//     两样有一样不空就留在旧服务上等 —— 在跑的终端命令、开着的预览都不被打断。
//   · 都空了：攥住维护锁（别处这时不许起服务）→ 拿接管许可（POST /api/runtime-handover，holdResources：许可发下
//     之前服务端在封口之后再看一次终端这些，有就不发）→ 给库留底 → 核对许可还有效 → 停掉旧服务（agent 的进程树
//     保住，见 restart.mjs）→ 松开维护锁，窗口重连时 launcher 用新运行时起服务，新服务按 pid 认回 agent。
// 中途哪一步不成都不停旧服务，回去接着等；连着 4 次拿不到许可就不再自动试，菜单里留「重试切换到新版服务…」。
// 用户也可以从菜单「切换到新版服务…」现在就换：把会被打断的摆给他看，他点了才不等。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishedRuntime, samePath, storeContains } from "./config.mjs";
import { backupDatabase } from "./db-backup.mjs";
import { ours, probe as probeHealth } from "./health.mjs";
import { publishRuntime } from "./launcher.mjs";
import { activeHold, beginMaintenance } from "./maintenance.mjs";
import { hostToken, stopServer } from "./restart.mjs";

const RETRY_LIMIT = 4;
const NOTE = "正在切换到新版 Navi 服务…";

/** 新运行时自报的接管协议（bundle-runtime 写的 .handover.json）：{ protocol: 1, schema }，认不出是 null。 */
export function compatibilityOf(runtime) {
  try {
    const value = JSON.parse(readFileSync(join(runtime, ".handover.json"), "utf8"));
    return value?.protocol === 1 && typeof value.schema === "string" && value.schema ? { protocol: 1, schema: value.schema } : null;
  } catch { return null; }
}

/** restart-impact 的答复 → 还要等的那些（{ title, why }）；答复不足以下结论时是 { unknown }。 */
export function blockersOf(impact, compat) {
  const handover = impact?.runtimeHandover;
  if (!handover || !Array.isArray(handover.blocked)) return { unknown: "旧服务没报能不能交接（它比这个 app 旧太多？）" };
  if (handover.target?.protocol !== compat.protocol || handover.target?.schema !== compat.schema) return { unknown: "旧服务没有核对新版的兼容性" };
  if (!Array.isArray(impact.shutdown?.resources)) return { unknown: "旧服务没报终端、项目服务这些会随它一起停的东西" };
  return {
    items: [
      ...handover.blocked.map((item) => ({ id: item.id, title: item.title ?? item.id, why: item.reason || "新版接不住" })),
      ...impact.shutdown.resources.map((item) => ({ id: `${item.kind}:${item.id}`, title: item.label || `${item.kind} ${item.id}`, why: "旧服务一停它就没了" })),
    ],
  };
}

export function createHandover({ cfg, ui, timing = {}, overrides = {} }) {
  const deps = {
    probe: () => probeHealth(cfg.baseURL),
    publish: () => publishRuntime(cfg),
    impact: (instance, compat) => askImpact(cfg, instance, compat),
    handover: (instance, body) => postHandover(cfg, instance, body),
    stop: (target) => stopServer(cfg, target),
    backup: (from) => backupDatabase(cfg, from),
    begin: (note) => beginMaintenance(cfg, note, 50_000),
    ...overrides,
  };
  const t = { poll: 5_000, ...timing };
  // phase：idle 不用换 / waiting 在等 / blocked 自动切换停了、等用户 / switching 正在换
  const state = { phase: "idle", items: [], why: null, failures: 0, timer: null, busy: false, from: null };

  const menu = () => ({
    visible: state.phase === "waiting" || state.phase === "blocked",
    title: state.phase === "blocked" ? "重试切换到新版服务…" : "切换到新版服务…",
  });
  const setPhase = (phase) => { state.phase = phase; ui.menu(); };

  /** 控制器每认出一次自己那份服务就告诉这里一声。 */
  function observe(instance) {
    if (!cfg.isLocal || !instance?.codeDir || state.phase === "switching") return;
    const target = publishedRuntime(cfg);
    if (!target || samePath(instance.codeDir, target, cfg.windows) || !storeContains(cfg, instance.codeDir)) {
      if (state.phase !== "idle") { stopTimer(); state.failures = 0; setPhase("idle"); }
      return;
    }
    if (state.phase !== "idle") return;
    state.from = instance.codeDir.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1).slice(0, 12);
    ui.log(`服务还跑在旧运行时 ${state.from} 上，等它能交接时换到新版`);
    setPhase("waiting");
    schedule(0);
  }

  function schedule(delay = Math.min(60_000, t.poll * 2 ** state.failures)) {
    stopTimer();
    state.timer = setTimeout(() => void tick(), delay);
  }
  function stopTimer() { clearTimeout(state.timer); state.timer = null; }

  async function tick() {
    if (state.busy || state.phase !== "waiting") return;
    state.busy = true;
    try {
      const verdict = await assess();
      if (verdict.kind === "clear") return void await switchOver(verdict, { force: false });
      record(verdict);
    } finally {
      state.busy = false;
      if (state.phase === "waiting") schedule();
    }
  }

  function record(verdict) {
    if (verdict.kind === "done") { state.failures = 0; return setPhase("idle"); }
    const before = JSON.stringify([state.items, state.why]);
    state.items = verdict.items ?? [];
    state.why = verdict.why ?? null;
    if (JSON.stringify([state.items, state.why]) !== before) {
      ui.log(state.why ? `还不能切换：${state.why}` : `等这些结束再切换：${state.items.map((item) => item.title).join("；")}`);
    }
  }

  /** { kind: "clear", instance, compat } / { kind: "wait", items } / { kind: "unknown", why } / { kind: "done" }（已经在新版上、或者服务不在了）。 */
  async function assess() {
    const hold = activeHold(cfg);
    if (hold) return { kind: "unknown", why: hold };
    const result = await deps.probe();
    if (result.kind === "down") return { kind: "done" };
    const instance = ours(result, cfg);
    if (!instance) return { kind: "unknown", why: "端口上这会儿认不出自己那份服务" };
    const target = publishedRuntime(cfg);
    if (samePath(instance.codeDir, target, cfg.windows)) return { kind: "done" };
    let runtime;
    try { runtime = await deps.publish(); }
    catch (error) { return { kind: "unknown", why: `新版运行时没准备好：${error.message}` }; }
    const compat = compatibilityOf(runtime);
    if (!compat) return { kind: "unknown", why: "新版运行时没带接管协议，核实不了能不能无损交接" };
    const answer = await deps.impact(instance.id, compat);
    if (answer.error) return { kind: "unknown", why: `问不到旧服务：${answer.error}` };
    const found = blockersOf(answer.impact, compat);
    if (found.unknown) return { kind: "unknown", why: found.unknown };
    return found.items.length ? { kind: "wait", items: found.items } : { kind: "clear", instance, compat };
  }

  async function switchOver({ instance, compat }, { force }) {
    setPhase("switching");
    ui.hold("正在切换到新版 Navi 服务", "在跑的任务不停，新版服务起来后接着接管它们。");
    let end = null;
    let lease = null;
    let outcome;
    try {
      end = await deps.begin(NOTE);
      outcome = await stopOld(instance, compat, force, (value) => { lease = value; });
    } catch (error) {
      outcome = { kind: "changed", why: error.message };
    }
    if (outcome.kind !== "stopped" && lease) await deps.handover(instance.id, { release: lease }).catch(() => {});
    end?.();
    if (outcome.kind === "stopped") {
      ui.log(`旧服务（进程 ${instance.pid}）已停，库的底：${outcome.backup ?? "还没有库"}；换新版运行时起`);
      state.failures = 0;
      state.items = [];
      state.why = null;
      setPhase("idle");
      return ui.release();
    }
    ui.log(`没切换：${outcome.why}`);
    state.why = outcome.why;
    state.failures += 1;
    setPhase(state.failures >= RETRY_LIMIT && !force ? "blocked" : "waiting");
    if (state.phase === "blocked") ui.log(`连着 ${state.failures} 次没拿到接管许可，不再自动试；旧服务照常跑，可从菜单重试`);
    ui.release();
    if (force) await ui.alert("没有切换", `${outcome.why}\n\n旧服务照常在跑，可以再试一次。`);
    if (state.phase === "waiting") schedule();
  }

  /** 维护锁攥着时做：认人 → 许可 → 留底 → 核对许可 → 停。返回 { kind: "stopped", backup } 或 { kind: "changed", why }。 */
  async function stopOld(instance, compat, force, keep) {
    const now = ours(await deps.probe(), cfg);
    if (!now || now.id !== instance.id) return { kind: "changed", why: "端口上的服务换了一份" };
    let lease = null;
    if (!force) {
      const granted = await deps.handover(instance.id, { ...compat, holdResources: true });
      if (!granted.lease) return { kind: "changed", why: granted.error ?? "旧服务这会儿不能安全交接" };
      lease = granted.lease;
      keep(lease);
      if (granted.protocol !== 1) return { kind: "changed", why: "新旧两版的接管协议对不上" };
    }
    let backup;
    try { backup = await deps.backup(state.from ?? "old"); }
    catch (error) { return { kind: "changed", why: `切换前给库留底失败（${error.message}），旧服务没停` }; }
    if (lease && (await deps.handover(instance.id, { check: lease })).valid !== true) {
      return { kind: "changed", why: "接管许可已经失效，旧服务没停" };
    }
    const stopped = await deps.stop({ kind: "ours", pid: instance.pid });
    if (stopped.kind !== "stopped") return { kind: "changed", why: stopped.why };
    return { kind: "stopped", backup };
  }

  /** 菜单里那一项：现在就问一遍；能无损换就换，不能就把会被打断的摆给用户，他点了才不等。 */
  async function reconsider() {
    if (state.busy || (state.phase !== "waiting" && state.phase !== "blocked")) return;
    stopTimer();
    state.busy = true;
    try {
      state.failures = 0;
      if (state.phase === "blocked") setPhase("waiting");
      const verdict = await assess();
      if (verdict.kind === "clear") return void await switchOver(verdict, { force: false });
      record(verdict);
      if (verdict.kind === "done") return ui.release();
      const lines = verdict.kind === "wait"
        ? ["现在切换会打断：", ...verdict.items.slice(0, 8).map((item) => `· ${item.title} —— ${item.why}`),
          ...(verdict.items.length > 8 ? [`…另有 ${verdict.items.length - 8} 个`] : [])]
        : [`确认不了现在切换会不会打断谁（${verdict.why}），按会打断对待。`];
      lines.push("", "选「继续等」的话，这些都结束后自动切换；旧服务和在跑的任务照常。");
      const choice = await ui.ask("现在就切换到新版服务？", lines.join("\n"), ["继续等", "现在切换"]);
      if (choice !== 1) return;
      const result = await deps.probe();
      const instance = ours(result, cfg);
      if (!instance) return void await ui.alert("没有切换", "端口上这会儿认不出自己那份服务。");
      const runtime = await deps.publish().catch(() => null);
      await switchOver({ instance, compat: runtime && compatibilityOf(runtime) }, { force: true });
    } finally {
      state.busy = false;
      if (state.phase === "waiting" && !state.timer) schedule();
    }
  }

  return {
    observe,
    reconsider: () => void reconsider(),
    menu,
    stop: stopTimer,
    state,
  };
}

async function request(cfg, instance, path, init = {}) {
  const token = hostToken(cfg);
  if (!token) return { error: "读不到数据根里那张服务凭证" };
  const headers = { "x-navi-host-token": token, "x-navi-instance": instance, ...(init.body ? { "content-type": "application/json" } : {}) };
  try {
    const response = await fetch(new URL(path, cfg.baseURL), { ...init, headers, signal: AbortSignal.timeout(45_000) });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch (error) {
    return { error: error.message };
  }
}

async function askImpact(cfg, instance, compat) {
  const query = new URLSearchParams({ protocol: String(compat.protocol), schema: compat.schema, shutdown: "1" });
  const answer = await request(cfg, instance, `/api/restart-impact?${query}`);
  if (answer.error) return answer;
  if (answer.status !== 200 || !answer.body) return { error: `服务端回 ${answer.status}` };
  return { impact: answer.body };
}

async function postHandover(cfg, instance, body) {
  const answer = await request(cfg, instance, "/api/runtime-handover", { method: "POST", body: JSON.stringify(body) });
  if (answer.error) return { error: answer.error };
  return { ...(answer.body ?? {}), ...(answer.status === 200 ? {} : { error: answer.body?.error ?? `服务端回 ${answer.status}` }) };
}
