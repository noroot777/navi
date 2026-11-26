// 装了新版之后把服务换到新运行时上（对应 mac 的 UpdateGate 里 preservingRuntime 那一段，README「装之前那道闸」）。
//
// 更新只换安装目录里的壳和运行时发布源，服务还在 %LOCALAPPDATA%\Navi\runtimes\<旧 id>\ 里跑、agent 也照常跑。
// 新壳一认出端口上是自己那份、跑的却是旧运行时，就在这里每 5 秒问一次旧服务「现在能不能无损交接」：
//   · /api/restart-impact?protocol=&schema=&shutdown=1：runtimeHandover.blocked 是新版接不住的回合（排队中、
//     调度台回合、agent 进程不对等），shutdown.resources 是旧服务一停就跟着没的东西（终端、项目服务、预览）。
//     两样有一样不空就留在旧服务上等 —— 在跑的终端命令、开着的预览都不被打断。
//   · 都空了：攥住维护锁（别处这时不许起服务）→ 拿接管许可（POST /api/runtime-handover，holdResources：许可发下
//     之前服务端在封口之后再看一次终端这些，有就不发）→ 给库留底 → 兑现许可（核验和下线是旧服务里同一步：兑现了
//     它就自己退出，撤不回）→ 等它退干净（没退就停掉，agent 的进程树保住，见 restart.mjs）→ 松开维护锁，
//     窗口重连时 launcher 用新运行时起服务，新服务按 pid 认回 agent。
// 旧服务一停，起新版就是这里的事：兑现、强停这两步撤不回，发出去之前先记下这份责任（handover-duty.mjs），看到
// 新版、或者旧服务自己说没兑现才结清。兑现没收到答复时只会接着问它（兑现是幂等的），问不到答案就不停它：
// 探不到它不等于它下线了，更不等于可以停它。壳被关掉、崩了（控制器的 stdin 断了）也先把这一趟做完、把责任结清再退
// （settled / successorPending / discharge，controller-main.mjs）。
// 中途哪一步不成都不停旧服务，回去接着等；连着 4 次拿不到许可就不再自动试，菜单里留「重试切换到新版服务…」。
// 用户也可以从菜单「切换到新版服务…」现在就换：把会被打断的摆给他看，他点了才不等。他点的是那一刻那一份服务、
// 那一张名单 —— 维护锁里认一遍人，再带着那张名单（accept）去拿许可：旧服务先封口、封口之后核对，多了他没见过的
// 就不发许可、当场解封，这边把新名单再摆给他；发了许可就和自动切换一样兑现、它自己退出，封口一直保持到那时。
// 在这边查一遍名单再去停不行：查完到停下之间旧服务照样能接新终端、新任务。
// 新版运行时没发布好（发布、校验失败，或包里没有接管协议）不是「会打断谁」的问题，强制也不切：旧服务一停新版起不来。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishedRuntime, samePath, storeContains } from "./config.mjs";
import { backupDatabase } from "./db-backup.mjs";
import { createDuty } from "./handover-duty.mjs";
import { ours, probe as probeHealth } from "./health.mjs";
import { publishRuntime } from "./launcher.mjs";
import { activeHold, beginMaintenance, isPidAlive } from "./maintenance.mjs";
import { hostToken, stopServer } from "./restart.mjs";

const RETRY_LIMIT = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOTE = "正在切换到新版 Navi 服务…";

/** 新运行时自报的接管协议（bundle-runtime 写的 .handover.json）：{ protocol: 1, schema }，认不出是 null。 */
export function compatibilityOf(runtime) {
  try {
    const value = JSON.parse(readFileSync(join(runtime, ".handover.json"), "utf8"));
    return value?.protocol === 1 && typeof value.schema === "string" && value.schema ? { protocol: 1, schema: value.schema } : null;
  } catch { return null; }
}

// 终端的 label 只是会话名（「PowerShell」这种），单看认不出是什么；别的几类（预览试跑、聊天执行）自己就带着说明。
const resourceTitle = (item) => (item.kind === "terminal" ? `终端「${item.label || item.id}」` : item.label || `${item.kind} ${item.id}`);

/** restart-impact 的答复 → 还要等的那些（{ title, why }）；答复不足以下结论时是 { unknown }。 */
export function blockersOf(impact, compat) {
  const handover = impact?.runtimeHandover;
  if (!handover || !Array.isArray(handover.blocked)) return { unknown: "旧服务没报能不能交接（它比这个 app 旧太多？）" };
  if (handover.target?.protocol !== compat.protocol || handover.target?.schema !== compat.schema) return { unknown: "旧服务没有核对新版的兼容性" };
  if (!Array.isArray(impact.shutdown?.resources)) return { unknown: "旧服务没报终端、项目服务这些会随它一起停的东西" };
  return {
    items: [
      ...handover.blocked.map((item) => ({ id: item.id, title: item.title ?? item.id, why: item.reason || "新版接不住" })),
      ...impact.shutdown.resources.map((item) => ({ id: `${item.kind}:${item.id}`, title: resourceTitle(item), why: "旧服务一停它就没了" })),
    ],
  };
}

/** busy：别处这会儿占着窗口那一屏（在下更新，见 updates.mjs）时说一声为什么，有就不切。 */
export function createHandover({ cfg, ui, busy = () => null, timing = {}, overrides = {} }) {
  const deps = {
    probe: () => probeHealth(cfg.baseURL),
    publish: () => publishRuntime(cfg),
    impact: (instance, compat) => askImpact(cfg, instance, compat),
    handover: (instance, body, timeoutMs) => postHandover(cfg, instance, body, timeoutMs),
    alive: (pid) => isPidAlive(pid),
    stop: (target) => stopServer(cfg, target),
    backup: (from) => backupDatabase(cfg, from),
    begin: (note) => beginMaintenance(cfg, note, 50_000),
    ...overrides,
  };
  // lease：服务端许可的时长，答复里没带最晚兑现时刻时用；answer：过了那个时刻还给它多久答话；ask：问一次兑没兑现最多等多久
  const t = { poll: 5_000, beat: 200, lease: 60_000, answer: 10_000, ask: 5_000, discharge: 90_000, retry: 2_000, ...timing };
  // phase：idle 不用换 / waiting 在等 / blocked 自动切换停了、等用户 / switching 正在换
  // inflight：正在做的那一趟（攥锁到松锁）
  const state = { phase: "idle", items: [], why: null, failures: 0, timer: null, busy: false, from: null, inflight: null, asking: false };
  const duty = createDuty();

  const menu = () => ({
    visible: state.phase === "waiting" || state.phase === "blocked",
    title: state.phase === "blocked" ? "重试切换到新版服务…" : "切换到新版服务…",
  });
  const setPhase = (phase) => { state.phase = phase; ui.menu(); };

  /** 控制器每认出一次自己那份服务就告诉这里一声。 */
  function observe(instance) {
    if (duty.settle(instance)) void ask(instance);
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

  /**
   * { kind: "clear", instance, compat } / { kind: "wait", items, instance, compat } / { kind: "unknown", why, instance?, compat? }
   * / { kind: "unprepared", why }（新版运行时没准备好，强制也不切）/ { kind: "done" }（已经在新版上、或者服务不在了）。
   */
  async function assess() {
    const hold = activeHold(cfg) ?? busy();
    if (hold) return { kind: "unknown", why: hold };
    const result = await deps.probe();
    if (result.kind === "down") return { kind: "done" };
    const instance = ours(result, cfg);
    if (!instance) return { kind: "unknown", why: "端口上这会儿认不出自己那份服务" };
    const target = publishedRuntime(cfg);
    if (samePath(instance.codeDir, target, cfg.windows)) return { kind: "done" };
    const prepared = await prepare();
    if (prepared.why) return { kind: "unprepared", why: prepared.why };
    const { compat } = prepared;
    const answer = await deps.impact(instance.id, compat);
    if (answer.error) return { kind: "unknown", why: `问不到旧服务：${answer.error}`, instance, compat };
    const found = blockersOf(answer.impact, compat);
    if (found.unknown) return { kind: "unknown", why: found.unknown, instance, compat };
    return found.items.length ? { kind: "wait", items: found.items, instance, compat } : { kind: "clear", instance, compat };
  }

  /** 发布并校验新版运行时：{ compat } 或 { why }。 */
  async function prepare() {
    let runtime;
    try { runtime = await deps.publish(); }
    catch (error) { return { why: `新版运行时没准备好：${error.message}` }; }
    const compat = compatibilityOf(runtime);
    return compat ? { compat } : { why: "新版运行时没带接管协议，核实不了能不能无损交接" };
  }

  /**
   * 返回这一趟的结局：{ kind: "stopped" } / { kind: "changed", why } / { kind: "widened" }（强制切换时名单或那份服务变了，
   * 没停，交回 reconsider 重新问）。confirmed：用户确认过的那张名单的 id；null 是他对着「确认不了」点的，按一项都没
   * 确认过算 —— 旧服务封口之后有会被打断的，就把那张名单再摆给他。
   */
  async function switchOver({ instance, compat, confirmed = null }, { force }) {
    const other = busy();
    if (other) {
      if (force) await ui.alert("没有切换", `${other}，等它完了再切换。旧服务照常在跑。`);
      return { kind: "changed", why: other };
    }
    setPhase("switching");
    ui.hold("正在切换到新版 Navi 服务", force
      ? "你确认过会被打断的那些会停下；别的在跑的任务不停，新版服务起来后接着接管它们。"
      : "在跑的任务不停，新版服务起来后接着接管它们。");
    state.inflight = run(instance, compat, force ? confirmed : undefined, force);
    const outcome = await state.inflight;
    state.inflight = null;
    if (outcome.kind === "stopped") {
      ui.log(`旧服务（进程 ${instance.pid}）已停，库的底：${outcome.backup ?? "还没有库"}；换新版运行时起`);
      state.failures = 0;
      state.items = [];
      state.why = null;
      setPhase("idle");
      ui.release();
      return outcome;
    }
    if (outcome.kind === "widened") {
      ui.log("确认之后情况变了，没切换，重新问一遍");
      setPhase("waiting");
      ui.release();
      return outcome;
    }
    ui.log(`没切换：${outcome.why}`);
    state.why = outcome.why;
    state.failures += 1;
    setPhase(state.failures >= RETRY_LIMIT && !force ? "blocked" : "waiting");
    if (state.phase === "blocked") ui.log(`连着 ${state.failures} 次没拿到接管许可，不再自动试；旧服务照常跑，可从菜单重试`);
    ui.release();
    if (force) await ui.alert("没有切换", `${outcome.why}\n\n旧服务照常在跑，可以再试一次。`);
    if (state.phase === "waiting") schedule();
    return outcome;
  }

  /** 攥锁 → stopOld → 没停成就还回许可 → 松锁。只碰服务和锁，不碰窗口：窗口没了它也照样做完（settled）。 */
  async function run(instance, compat, confirmed, force) {
    let end = null;
    let lease = null;
    let outcome;
    try {
      // 强制切换前重新发布一遍：用户对着对话框想了多久都行，停旧服务前新版必须还在、还完整。
      const prepared = force ? await prepare() : { compat };
      if (prepared.why) outcome = { kind: "changed", why: prepared.why };
      else {
        end = await deps.begin(NOTE);
        outcome = await stopOld(instance, prepared.compat, confirmed, (value) => { lease = value; });
      }
    } catch (error) {
      outcome = { kind: "changed", why: error.message };
    }
    if (outcome.kind !== "stopped" && lease) {
      // 归还成功就是旧服务亲口说许可没兑现、也再兑现不了（兑现过的许可还不回去）：欠的结清。
      const back = await deps.handover(instance.id, { release: lease }, t.ask).catch(() => ({}));
      if (back.released === true && duty.owed?.lease === lease) duty.clear();
    }
    // 松锁出错也不能把这一趟（和它欠下的起新版）一起丢掉：记一笔，照常交回结局。
    try { end?.(); } catch (error) { ui.log(`松开维护锁出错：${error.message}`); }
    return outcome;
  }

  /**
   * 维护锁攥着时做：认人 → 许可 → 留底 → 兑现许可 → 等它退。confirmed 是 undefined 时是自动切换（无损交接的许可）；
   * 强制切换带上用户确认过的那张（accept，null 是对着「确认不了」点的、按一项都没确认过算），名单由旧服务封口之后核对。
   */
  async function stopOld(instance, compat, confirmed, keep) {
    const now = ours(await deps.probe(), cfg);
    if (!now || now.id !== instance.id) return confirmed === undefined ? { kind: "changed", why: "端口上的服务换了一份" } : { kind: "widened" };
    const accept = confirmed === undefined ? {} : { accept: [...(confirmed ?? [])] };
    const granted = await deps.handover(instance.id, { ...compat, holdResources: true, ...accept });
    if (!granted.lease) {
      if (confirmed !== undefined && Array.isArray(granted.widened)) return { kind: "widened" };
      return { kind: "changed", why: granted.error ?? "旧服务这会儿不能安全交接" };
    }
    const lease = granted.lease;
    keep(lease);
    if (granted.protocol !== 1) return { kind: "changed", why: "新旧两版的接管协议对不上" };
    // 许可最晚兑现到什么时刻：服务端说了就用它的；没说就按收到答复的时刻 + 许可时长算（同一台机器同一个钟，
    // 服务端的到期时刻是在答复发出之前定的，只会更早）。过了它，晚到的兑现服务端一律拒。
    const fence = Number.isFinite(granted.expiresAt) ? granted.expiresAt : Date.now() + t.lease;
    let backup;
    try { backup = await deps.backup(state.from ?? "old"); }
    catch (error) { return { kind: "changed", why: `切换前给库留底失败（${error.message}），旧服务没停` }; }
    duty.owe(instance, { lease, fence });
    const committed = await commit(instance, lease, fence);
    if (committed === "refused") {
      duty.clear();
      return { kind: "changed", why: "接管许可已经失效，旧服务没停" };
    }
    // 问不到答案：它可能兑现了正在退，也可能没兑现、已经解封在接新活 —— 不去停它，责任留着，之后再问它。
    if (committed === null) return { kind: "changed", why: "兑现许可一直问不到结果（旧服务没有答复），没去停它" };
    // 走到这里，要么旧服务亲口说兑现了（它自己会退：这里等它退干净，没退就停掉 —— 它封着口、不接活了，停它不会带走新活），
    // 要么它的进程已经没了。
    const stopped = await deps.stop({ kind: "ours", pid: instance.pid });
    if (stopped.kind !== "stopped") return { kind: "changed", why: stopped.why };
    return { kind: "stopped", backup };
  }

  /**
   * 兑现许可，一直问到旧服务自己给出答案：committed 兑现了（它几百毫秒内自己退）/ refused 它明说没兑现 —— 兑现是幂等的，
   * 许可一旦到期或归还就再也兑现不了，所以这是终局，在途、晚到的那次也不会再执行 / gone 它的进程已经没了 / null 过了
   * 最晚兑现时刻、再给够 t.answer 还问不到答案。连接断了、超时、503 都只是「还不知道」：不当成没兑现，也不当成下线了。
   */
  async function commit(instance, lease, fence) {
    for (;;) {
      const answer = await deps.handover(instance.id, { commit: lease }, t.ask);
      if (answer.committed === true) return "committed";
      if (answer.committed === false && !answer.error) return "refused";
      if (!deps.alive(instance.pid)) return "gone";
      if (Date.now() > fence + t.answer) return null;
      await sleep(t.beat);
    }
  }

  /**
   * 欠着的那一份（走许可、还没问到答案）又在端口上答话了：问它兑没兑现。这时早过了最晚兑现时刻（stopOld 问满了才放手），
   * 这次「兑现」只是在问：兑现过的答 true（它正在退，接着欠着），没兑现的答 false（以后也不会了，结清）。
   */
  async function ask(instance) {
    const owed = duty.owed;
    if (!owed || instance?.id !== owed.from || state.asking || state.inflight || Date.now() <= owed.fence) return;
    state.asking = true;
    try {
      const answer = await deps.handover(instance.id, { commit: owed.lease }, t.ask);
      if (answer.committed === false && !answer.error && duty.owed === owed) {
        duty.clear();
        ui.log("交出去的旧服务说许可没兑现：它照常在跑，不用起新版");
      }
    } catch (error) {
      ui.log(`问旧服务兑没兑现出错：${error.message}`);
    } finally {
      state.asking = false;
    }
  }

  /**
   * 退出前把欠着的起新版做完：一直起到端口上是另一份服务、或者交出去的那份说它没兑现，整趟最多 t.discharge ——
   * 每一次起都只给剩下的时间（ensure(剩下的毫秒)，到点不等它）。ensure 是 launcher.ensureRunning。
   * 返回 { ok } 或 { ok: false, why }。
   */
  async function discharge(ensure) {
    const until = Date.now() + t.discharge;
    let why = null;
    while (duty.pending && Date.now() < until) {
      const outcome = await within(until - Date.now(), () => ensure(until - Date.now()));
      if (!outcome) break;
      if (outcome.kind === "ready" && duty.settle(outcome.instance)) {
        await ask(outcome.instance);
        why = "交出去的旧服务还在答话（它兑现过、正在下线，或者问不到它兑没兑现）";
      } else if (outcome.kind !== "ready") why = outcome.message ?? outcome.kind;
      if (duty.pending) await sleep(Math.max(0, Math.min(t.retry, until - Date.now())));
    }
    return duty.pending ? { ok: false, why: why ?? "等过了时限" } : { ok: true };
  }

  /** 菜单里那一项：现在就问一遍；能无损换就换，不能就把会被打断的摆给用户，他点了才不等。 */
  async function reconsider() {
    if (state.busy || (state.phase !== "waiting" && state.phase !== "blocked")) return;
    stopTimer();
    state.busy = true;
    try {
      state.failures = 0;
      if (state.phase === "blocked") setPhase("waiting");
      for (let round = 0; round < 3; round++) {
        const verdict = await assess();
        if (verdict.kind === "clear") return void await switchOver(verdict, { force: false });
        record(verdict);
        if (verdict.kind === "done") return ui.release();
        if (verdict.kind === "unprepared" || !verdict.instance) {
          return void await ui.alert("现在切换不了", `${verdict.why}\n\n旧服务照常在跑。`);
        }
        const lines = [
          ...(round ? ["刚才确认之后情况变了，按现在的再确认一次。", ""] : []),
          ...(verdict.kind === "wait"
            ? ["现在切换会打断：", ...verdict.items.slice(0, 8).map((item) => `· ${item.title} —— ${item.why}`),
              ...(verdict.items.length > 8 ? [`…另有 ${verdict.items.length - 8} 个`] : [])]
            : [`确认不了现在切换会不会打断谁（${verdict.why}）。点了之后旧服务先停止接活再核对：有会被打断的，会列出来再问你一次。`]),
          "", "选「继续等」的话，这些都结束后自动切换；旧服务和在跑的任务照常。",
        ];
        // 关掉对话框按最后一个算：最后一个是不动的那个。
        const choice = await ui.ask("现在就切换到新版服务？", lines.join("\n"), ["现在切换", "继续等"]);
        if (choice !== 0) return;
        const confirmed = verdict.kind === "wait" ? new Set(verdict.items.map((item) => item.id)) : null;
        const outcome = await switchOver({ instance: verdict.instance, compat: verdict.compat, confirmed }, { force: true });
        if (outcome.kind !== "widened") return;
      }
      await ui.alert("没有切换", "确认之后情况一直在变，这次没切换。旧服务照常在跑，可以再试一次。");
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
    /** 正在做的那一趟做完（没有就是马上）；控制器退出前等它。 */
    settled: () => state.inflight ?? Promise.resolve(null),
    /** 兑现、强停发出去了，还没看到新版、也没问到旧服务说没兑现：退出前得把新版起起来。 */
    successorPending: () => duty.pending,
    discharge,
    state,
  };
}

/** 至多等 ms 毫秒；到点还没结果是 null（那件事照样在跑，只是不等它了）。 */
async function within(ms, start) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, ms)); });
  try {
    return await Promise.race([Promise.resolve().then(start).catch((error) => ({ kind: "failed", message: error.message })), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function request(cfg, instance, path, init = {}, timeoutMs = 45_000) {
  const token = hostToken(cfg);
  if (!token) return { error: "读不到数据根里那张服务凭证" };
  const headers = { "x-navi-host-token": token, "x-navi-instance": instance, ...(init.body ? { "content-type": "application/json" } : {}) };
  try {
    const response = await fetch(new URL(path, cfg.baseURL), { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
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

async function postHandover(cfg, instance, body, timeoutMs) {
  const answer = await request(cfg, instance, "/api/runtime-handover", { method: "POST", body: JSON.stringify(body) }, timeoutMs);
  if (answer.error) return { error: answer.error };
  return { ...(answer.body ?? {}), ...(answer.status === 200 ? {} : { error: answer.body?.error ?? `服务端回 ${answer.status}` }) };
}
