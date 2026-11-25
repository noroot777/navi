// 窗口「回到 navi」的那条路，以及页面在的时候一直认着人（对应 mac 的 LaunchFlow.swift 与 BrowserWindowController.swift
// 里认人、撤页、探活、交接那几段）。壳只管画：这里决定窗口此刻该是哪一屏、载哪个地址、带哪个实例号。
//
// 和壳之间是一行一条 JSON（controller-main.mjs 接到 stdin / stdout）。发给壳的：
//   { type: "screen", screen }                 盖上本地那一屏（ui/index.html）：offline / firstRun / blank
//   { type: "load", url, cookie, instance }    先把实例号写成 cookie，再把页面载到 url；instance 也交给壳的导航前认人
//   { type: "route", route }                   页面在着时原地换路由（推一条历史、发一次 popstate，同 web 的 navigation.ts）
//   { type: "reload" } { type: "window", size } { type: "front" } { type: "openExternal", url } { type: "openPath", path }
//   { type: "dialog", id, title, detail, buttons }  弹原生对话框，壳回 { type: "dialogResult", id, index }
//   { type: "menu", remote, login }            托盘菜单里两个勾此刻的样子
// 壳发来的：started（主框架开始载一份文档）、report（页面表态：size:<setup|work> / titlebar / broken:<地址>；
//   url:<地址> 是页面内换了地址，不换文档）、
//   navigationBlocked（壳的导航前认人没过）、action（本地那一屏上的按钮）、menu（托盘菜单）、link（navi:// 链接）、dialogResult。
import { mkdirSync } from "node:fs";
import { runtimeId } from "./config.mjs";
import { decideLink, parseLink } from "./deep-link.mjs";
import { isServing, mismatch, ours, probe as probeHealth } from "./health.mjs";
import { activeHold, beginMaintenance } from "./maintenance.mjs";
import { assessImpact, freezeImpact, releaseFreeze, renewFreeze, stopServer, widened } from "./restart.mjs";
import { allowsOtherDevices, writeSettings } from "./settings.mjs";

export const INSTANCE_COOKIE = "navi_instance";
/** 新文档开始载入后最多等它多久表态。认约定的页面身份确认通常在一秒内；再久就是出事了。 */
const PRESENT_TIMEOUT_MS = 15_000;

export function createController({ cfg, send, launcher, loginItem, timing = {}, overrides = {} }) {
  const deps = {
    probeMain: () => probeHealth(cfg.baseURL),
    probeWindow: () => probeHealth(cfg.windowURL),
    assess: () => assessImpact(cfg),
    freeze: () => freezeImpact(cfg, { assess: () => deps.assess() }),
    renew: renewFreeze,
    release: releaseFreeze,
    stop: (target, options) => stopServer(cfg, target, options),
    ...overrides,
  };
  const t = { guard: 1_000, poll: 2_000, starting: 400, present: PRESENT_TIMEOUT_MS, holdRetry: 2_000, ...timing };
  const state = {
    generation: 0, bound: null, pageURL: null, resumeURL: null, pendingRoute: null,
    document: 0, presentation: "invalid", handoff: null, screen: null, actions: new Map(),
    guard: null, guardProbing: false, unreachable: 0, poll: null, starting: null,
    linkSerial: 0, welcoming: null, served: null, remoteBusy: false, dialogs: new Map(), dialogSerial: 0,
  };

  const sameOrigin = (url) => {
    try { return new URL(url).origin === new URL(cfg.windowURL).origin; } catch { return false; }
  };
  const hasPresentedPage = () => state.presentation === "presented" && !state.screen;

  // ── 本地那一屏 ──────────────────────────────────────────────────────────

  function show(screen, actions = []) {
    state.screen = screen;
    state.actions = new Map(actions.map((action) => [action.id, action.run]));
    send({ type: "screen", screen: { ...screen, actions: actions.map(({ id, title }) => ({ id, title })) } });
  }

  const retry = () => ({ id: "retry", title: "重试", run: () => loadHome() });

  function showInstalling(title, detail = "完成后自动回到工作区。") {
    resetPageConnection();
    show({ kind: "offline", title, detail, busy: true });
  }

  // ── 认人、起服务、载页面 ───────────────────────────────────────────────

  /** 本机地址先认清端口上是不是自己那份（不在就起，被别人占着就说明），确认了才载页面；连别处的 navi 时直接载。 */
  function loadHome({ quietly = false } = {}) {
    resetPageConnection();
    if (!cfg.isLocal) return void loadPage();
    void connect(quietly);
  }

  async function connect(quietly) {
    const hold = activeHold(cfg);
    if (hold) {
      showInstalling(hold);
      // 维护在别的进程里（另开的一份壳在重启服务）：它完了不会通知这里，过一会儿再看一次。
      if (!state.remoteBusy) {
        const generation = state.generation;
        setTimeout(() => { if (state.generation === generation) loadHome(); }, t.holdRetry);
      }
      return;
    }
    clearTimeout(state.starting);
    // 「正在启动」那一屏晚一点才盖上：服务本来就在时探一下只要几毫秒，不该闪一下。
    if (!quietly) state.starting = setTimeout(() => show({ kind: "offline", title: "正在启动 Navi", detail: "就绪后自动回到工作区。", busy: true }), t.starting);
    const generation = state.generation;
    const outcome = await launcher.ensureRunning(undefined, (phase) => {
      if (phase !== "publishing" || state.generation !== generation) return;
      clearTimeout(state.starting);
      const detail = "第一次打开（或更新之后）要先把自带的运行时放到位，可能要几分钟。";
      if (state.screen?.kind === "firstRun") show({ ...state.screen, busy: "正在准备自带的运行时，第一次要几分钟…" });
      else show({ kind: "offline", title: "正在准备 Navi", detail, busy: true });
    });
    clearTimeout(state.starting);
    if (state.generation !== generation) return;
    present(outcome);
  }

  function present(outcome) {
    if (outcome.kind === "ready") {
      observe(outcome.instance);
      return void loadPage();
    }
    if (outcome.kind === "needsSetup") return showFirstRun();
    if (outcome.kind === "occupied") {
      show({ kind: "offline", title: `${cfg.port} 端口被占着`, detail: outcome.message }, [retry()]);
      return startPolling(cfg.baseURL, { takeOverWhenFree: true });
    }
    const actions = [{ id: "logs", title: "日志", run: openLogs }, retry()];
    show({ kind: "offline", title: "Navi 服务没起来", detail: outcome.message }, actions);
    startPolling(cfg.baseURL);
  }

  function showFirstRun(problem = null) {
    window("setup");
    show({ kind: "firstRun", dataPath: cfg.dataDir, problem, busy: null }, [{
      id: "fresh",
      title: "全新开始",
      run: () => {
        show({ kind: "firstRun", dataPath: cfg.dataDir, problem: null, busy: "正在启动 Navi…" });
        launcher.approveFreshStart();
        loadHome({ quietly: true });
      },
    }]);
  }

  /** 把页面载进来。连别处的 navi 时直接载；本机地址先认一次人、把那一份的实例号交给页面再载。 */
  async function loadPage() {
    if (!cfg.isLocal) return showPage();
    const generation = state.generation;
    const result = await deps.probeWindow();
    if (state.generation !== generation) return;
    const instance = ours(result, cfg);
    if (!instance) return windowPortUnusable(result);
    observe(instance);
    state.bound = instance.id;
    showPage();
  }

  /**
   * 主端口上认出了自己那份（它也报了在窗口专用端口上听着），窗口端口上却不是它：连不上、答的是别人。不能回头
   * 再走一遍 loadHome —— 主端口照样就绪，马上又到这里，一圈接一圈地空转。说清楚，隔一阵探一次窗口端口，通了再载。
   */
  function windowPortUnusable(result) {
    if (!state.resumeURL && state.pageURL && sameOrigin(state.pageURL)) state.resumeURL = state.pageURL;
    state.bound = null;
    const why = result.kind === "navi" ? mismatch(result.instance, cfg) ?? "答的不是这个 app 的那一份"
      : result.kind === "down" ? "没有程序在听" : result.reason ?? result.what;
    show({
      kind: "offline",
      title: "窗口连不上 Navi",
      detail: `服务在 ${cfg.port} 端口上好好的，窗口专用的 ${cfg.windowPort} 端口上却认不出它：${why}\n通了会自动回到工作区。`,
    }, [{ id: "logs", title: "日志", run: openLogs }, retry()]);
    startPolling(cfg.windowURL);
  }

  function showPage() {
    // 载页面就把本地那一屏换走了（壳是整页导航过去的），所以每次都要等页面表态（见 pageDidPresent）：
    // 刚打开时窗口里本来什么都没画，页面要是一直不表态，不能让人对着一扇空窗。原地重载（换实例号）不走这里。
    state.handoff = { document: null };
    const target = [state.pendingRoute, state.resumeURL, state.pageURL].find((url) => url && sameOrigin(url)) ?? `${cfg.windowURL}/`;
    state.resumeURL = null;
    state.pendingRoute = null;
    load(target);
    startGuard();
  }

  function load(url) {
    send({ type: "load", url, instance: state.bound, cookie: state.bound ? { name: INSTANCE_COOKIE, value: state.bound } : null });
  }

  function observe(instance) {
    state.served = instance;
    pushMenu();
  }

  /** 端口上不再是认过的那一份：页面连同它的轮询、SSE 一起撤掉（一个请求都不再发给新来的那份），记下路由，回到 loadHome 认一遍。 */
  function instanceLost() {
    if (state.pageURL && sameOrigin(state.pageURL)) state.resumeURL = state.pageURL;
    state.bound = null;
    state.served = null;
    show({ kind: "blank" });
    loadHome();
  }

  function resetPageConnection() {
    state.generation += 1;
    state.presentation = "invalid";
    clearTimeout(state.handoff?.timer);
    state.handoff = null;
    stopPolling();
    stopGuard();
    clearTimeout(state.starting);
  }

  // ── 页面在的时候也一直认着人 ───────────────────────────────────────────

  function startGuard() {
    if (!cfg.isLocal || state.guard) return;
    state.guard = setInterval(() => void checkInstance(state.guard), t.guard);
  }

  function stopGuard() {
    clearInterval(state.guard);
    state.guard = null;
    state.guardProbing = false;
    state.unreachable = 0;
  }

  async function checkInstance(timer) {
    if (state.guardProbing || state.guard !== timer) return;
    state.guardProbing = true;
    const result = await deps.probeWindow();
    if (state.guard !== timer) return;
    state.guardProbing = false;
    if (result.kind === "unreachable") {
      // 服务忙时连续几秒答不出探活，一个超时不能证明端口换了人。
      state.unreachable += 1;
      if (state.unreachable < 3) return;
    }
    const instance = ours(result, cfg);
    if (!instance) return instanceLost();
    state.unreachable = 0;
    // 还是自己那份，但服务重起过（实例号换了）：页面手上的旧实例号会被拒，换上新的重载一遍。
    if (instance.id !== state.bound) {
      observe(instance);
      state.bound = instance.id;
      load(state.pageURL && sameOrigin(state.pageURL) ? state.pageURL : `${cfg.windowURL}/`);
    }
  }

  /** 后台每 2 秒探一次：自己那份通了就载回去。`takeOverWhenFree`：端口被别人占着时，对方一停就接着起自己那份。 */
  function startPolling(base, { takeOverWhenFree = false } = {}) {
    if (state.poll) return;
    const probe = base === cfg.windowURL ? deps.probeWindow : () => probeHealth(base);
    const timer = setInterval(async () => {
      const result = await probe();
      const down = result.kind === "down" || result.kind === "unreachable";
      if (state.poll === timer && (isServing(result, cfg) || (takeOverWhenFree && down))) loadHome();
    }, t.poll);
    state.poll = timer;
  }

  function stopPolling() {
    clearInterval(state.poll);
    state.poll = null;
  }

  // ── 原生那一屏交给页面 ─────────────────────────────────────────────────
  // 服务通了只说明页面载得进来，不说明它已经画出来了。页面报了这一屏要多大的窗（认约定的页面在身份确认、画出第一屏
  // 或报错屏时报；不认约定的文档读完 <head> 时报 titlebar）才算交接完。等不到就换上一屏持久的说明，不把空页面放着。

  function pageStarted(url) {
    state.document += 1;
    state.presentation = sameOrigin(url) ? "committed" : "invalid";
    if (state.presentation !== "committed") return;
    state.pageURL = url;
    state.screen = null;
    if (!state.handoff) return;
    const document = state.document;
    clearTimeout(state.handoff.timer);
    state.handoff.document = document;
    state.handoff.timer = setTimeout(() => {
      if (state.handoff?.document === document) pageDidNotPresent(`页面载进来了，但等了 ${Math.round(t.present / 1000)} 秒还没显示出来。`);
    }, t.present);
  }

  function pageReport(kind) {
    // 页面在用户眼前时它此刻的地址：浏览器入口、换实例号重载、断线接回都从这里取，不是最近一次整页载入的那个地址。
    if (kind.startsWith("url:")) {
      const url = kind.slice(4);
      if (state.presentation !== "invalid" && sameOrigin(url)) state.pageURL = url;
      return;
    }
    if (kind.startsWith("size:")) { window(kind.slice(5)); return pageDidPresent(); }
    if (kind === "titlebar") { window("work"); return pageDidPresent(); }
    if (kind.startsWith("broken:") && state.handoff?.document === state.document) {
      pageDidNotPresent(`页面的脚本（${kind.slice(7)}）没有载进来。`);
    }
  }

  function pageDidPresent() {
    if (state.presentation !== "committed") return;
    if (state.handoff && state.handoff.document !== state.document) return;
    clearTimeout(state.handoff?.timer);
    state.handoff = null;
    if (!state.screen) state.presentation = "presented";
  }

  // 「仍然显示页面」给不报尺寸的旧版服务留一条明确的路：再载一次、不再等它表态。
  function pageDidNotPresent(reason) {
    if (!state.handoff) return;
    clearTimeout(state.handoff.timer);
    state.handoff = null;
    stopGuard();
    const target = state.pageURL ?? `${cfg.windowURL}/`;
    show({ kind: "offline", title: "页面没有显示出来", detail: `${reason}\n可以重试；要先看看页面现在的样子也行。` }, [
      { id: "showAnyway", title: "仍然显示页面", run: () => { load(target); startGuard(); } },
      retry(),
    ]);
  }

  /** 壳的导航前认人没过（页面自己的刷新、前进后退、跳转）。 */
  function navigationBlocked(url, reason) {
    if (reason !== "unreachable") return instanceLost();
    if (hasPresentedPage()) return;
    resetPageConnection();
    state.resumeURL = url;
    show({ kind: "offline", title: "连不上 Navi", detail: "窗口的端口这会儿没有答复。" }, [retry()]);
    startPolling(cfg.windowURL);
  }

  function window(size) {
    if (size !== "setup" && size !== "work") return;
    if (state.welcoming === (size === "setup")) return;
    state.welcoming = size === "setup";
    send({ type: "window", size });
  }

  // ── navi:// 链接 ──────────────────────────────────────────────────────
  // 等自家服务就绪、认过它的指纹再决定在窗口里开还是交给浏览器。连着点了几条时只有最后一条落地（linkSerial）。

  async function openLink(raw) {
    send({ type: "front" });
    const serial = ++state.linkSerial;
    const link = parseLink(raw);
    if (!link) return;
    const outcome = await launcher.ensureRunning();
    const tag = outcome.kind === "ready" ? ours(await deps.probeWindow(), cfg)?.tag ?? null : null;
    if (serial !== state.linkSerial) return;
    const action = decideLink(link, tag);
    if (action.kind === "browser") {
      state.pendingRoute = null;
      send({ type: "openExternal", url: action.url });
    } else if (action.kind === "window") {
      // 页面在着就原地换路由，不重载；页面还没载进来（服务在起、被占着、首启）就记下，载页面时直接载到那里。
      if (hasPresentedPage()) {
        state.pageURL = `${cfg.windowURL}${action.route}`;
        send({ type: "route", route: action.route });
      }
      else state.pendingRoute = `${cfg.windowURL}${action.route}`;
    }
  }

  // ── 菜单 ───────────────────────────────────────────────────────────────

  /** 在跑的服务没按菜单上的设置起：要别的设备进来、它却只听本机，或者反过来。不知道（还没认出、它没报）是 false。 */
  const networkPending = () => typeof state.served?.localOnly === "boolean" && state.served.localOnly === allowsOtherDevices(cfg);

  let loginEnabled = null;
  function pushMenu() {
    send({
      type: "menu",
      remote: {
        checked: allowsOtherDevices(cfg),
        title: networkPending() ? "允许其他设备访问（重启服务后生效）" : "允许其他设备访问",
        enabled: cfg.isLocal && !state.remoteBusy,
      },
      login: { checked: loginEnabled === true, enabled: Boolean(cfg.shellExe) && loginEnabled !== null },
    });
  }

  function refreshLogin() {
    try { loginEnabled = loginItem.isEnabled(); } catch { loginEnabled = null; }
    pushMenu();
  }

  function ask(title, detail, buttons) {
    const id = ++state.dialogSerial;
    send({ type: "dialog", id, title, detail, buttons });
    return new Promise((resolve) => state.dialogs.set(id, resolve));
  }
  const alert = (title, detail) => ask(title, detail, ["好"]);

  function openLogs() {
    try { mkdirSync(cfg.logsDir, { recursive: true }); } catch { /* 打开时说 */ }
    send({ type: "openPath", path: cfg.logsDir });
  }

  /** 窗口地址换回给浏览器用的地址（同一路由，4317 那一边）。 */
  function openInBrowser() {
    let url = cfg.baseURL;
    if (state.pageURL && sameOrigin(state.pageURL)) {
      const page = new URL(state.pageURL);
      url = `${cfg.baseURL}${page.pathname}${page.search}${page.hash}`;
    }
    send({ type: "openExternal", url });
  }

  async function toggleLogin() {
    try { loginItem.setEnabled(!loginItem.isEnabled()); }
    catch (error) { await alert("登录项没改成", error.message); }
    refreshLogin();
  }

  // 「允许其他设备访问」（对应 mac 的 RemoteAccessSwitch.swift）：服务听在哪、远程配对开不开，是起服务那一下由
  // NAVI_LOCAL_ONLY 定的，所以光改设置不够，得重启。先问会打断谁，会打断或者确认不了就摆给用户；放行后攥住维护锁，
  // 只停评估过的那一份，**确认停下之后、松开维护锁之前**才把新设置落盘，再按它起。中途在哪一步退出，留下的设置和
  // 服务都对得上；没停成就什么都不改。
  //
  // 确认框可能开着好一阵，这期间别处又起了任务，用户点头时看到的名单就过时了。所以攥住维护锁之后、停服务之前先让
  // 服务冻结接活、拿冻结之下的快照（freezeImpact，server/src/restart-freeze.ts），多出了他没同意过的影响（widened）
  // 就放开冻结、松锁、把新名单重新摆给他；没多出来就凭这份快照停，下刀前续一次期确认冻结还在。冻着的时候不起新回合，
  // 所以再评估到停下之间那一下也堵上了。老版本服务没有这道关口：退回即时再评估，确认框里如实说这一下堵不上。
  async function toggleRemote() {
    if (state.remoteBusy) return;
    const hold = activeHold(cfg);
    if (hold) return void alert("现在改不了", `${hold}。等它完了再改。`);
    state.remoteBusy = true;
    pushMenu();
    const enable = networkPending() ? allowsOtherDevices(cfg) : !allowsOtherDevices(cfg);
    let verdict = await deps.assess();
    let agreed = await confirmRemote(enable, verdict);
    let failure = null;
    let restarted = false;
    while (agreed) {
      showInstalling("正在重启 Navi", "正在应用访问设置，就绪后自动回到工作区。");
      restarted = true;
      let changed = null;
      try {
        const end = await beginMaintenance(cfg, "正在按新设置重启 Navi 服务…", 50_000);
        let lease = null;
        try {
          const frozen = await deps.freeze();
          if (frozen.kind === "refused") failure = `服务这会儿冻结不了接活（${frozen.why}），这次没有重启。`;
          else {
            lease = frozen.lease ?? null;
            if (widened(verdict, frozen.verdict)) changed = frozen.verdict;
            else {
              const beforeKill = lease ? () => deps.renew(lease) : undefined;
              const stopped = await deps.stop(verdict.target ?? null, { beforeKill });
              if (stopped.kind === "stopped") {
                lease = null; // 服务退了，冻结跟着没了
                state.served = null;
                writeSettings(cfg, { allowOtherDevices: enable });
              } else {
                failure = stopped.kind === "changed" ? `评估之后服务变了（${stopped.why}），这次没有重启。` : stopped.why;
              }
            }
          }
        } finally {
          // 没停成（名单变了要重问、停不下来）：服务还在，冻结当场放开，被挡住的任务接着起。
          if (lease) await deps.release(lease);
          end();
        }
      } catch (error) {
        failure = `没能让服务下线：${error.message}`;
      }
      if (!changed) break;
      verdict = changed;
      agreed = await confirmRemote(enable, verdict, { changed: true });
    }
    state.remoteBusy = false;
    pushMenu();
    if (failure) await alert("没有切换", `${failure}\n\n设置没改，可以再试一次。`);
    if (restarted) loadHome();
  }

  async function confirmRemote(enable, verdict, { changed = false } = {}) {
    // 改回只听本机是收窄，不打断谁就直接办。
    if (!enable && verdict.kind === "clear") return true;
    const lines = changed ? ["刚才确认之后情况变了，按现在的样子再确认一次。"] : [];
    let title;
    let primary;
    if (enable) {
      title = "允许其他设备访问这台 Navi？";
      lines.push(`服务不再只听 127.0.0.1：同一 Tailscale 或局域网里的设备连得上 ${cfg.port} 端口，进来仍要在这台电脑上批准配对，`
        + "或者输入访问密钥（设置 › 默认规则 › 远程访问）。手机上点飞书卡片的「在 Navi 中打开」也就打得开了。");
      lines.push("Windows 防火墙会问一次要不要让 node 接受传入连接，勾上「专用网络」后选「允许」。");
      primary = "打开并重启服务";
    } else {
      title = "改回只允许本机访问？";
      primary = "重启服务";
    }
    if (verdict.kind === "clear") lines.push("要重启 Navi 服务才生效，几秒钟就好；在跑的任务照常接着跑。");
    else if (verdict.kind === "disrupts") {
      const shown = verdict.items.slice(0, 8).map((item) => `· ${item.title} —— ${item.why}`);
      const more = verdict.items.length > shown.length ? [`…另有 ${verdict.items.length - shown.length} 个`] : [];
      lines.push(["要重启 Navi 服务才生效，现在重启会打断：", ...shown, ...more].join("\n"));
    } else lines.push(`要重启 Navi 服务才生效。确认不了重启会不会打断任务（${verdict.why}），按会打断对待。`);
    if (verdict.target?.kind === "ours" && verdict.freezable === false) {
      lines.push("这一版服务不支持重启前冻结：确认之后到停下之间新起的任务不在上面，也会被打断。");
    }
    return (await ask(title, lines.join("\n\n"), [primary, "取消"])) === 0;
  }

  function about() {
    const id = runtimeId(cfg.bundledRuntime);
    return alert(`Navi ${cfg.version}`, [
      `数据：${cfg.dataDir}`,
      `服务：${cfg.baseURL}${cfg.isLocal ? `（窗口用 127.0.0.1:${cfg.windowPort}）` : ""}`,
      ...(id ? [`运行时：${id.slice(0, 12)}`] : []),
      `日志：${cfg.logsDir}`,
    ].join("\n"));
  }

  // ── 壳发来的 ───────────────────────────────────────────────────────────

  const menuActions = {
    openInBrowser,
    logs: openLogs,
    reload: () => (hasPresentedPage() ? send({ type: "reload" }) : loadHome()),
    toggleRemote: () => void toggleRemote(),
    toggleLogin: () => void toggleLogin(),
    about: () => void about(),
  };

  function receive(message) {
    switch (message?.type) {
      case "started": return pageStarted(String(message.url ?? ""));
      case "report": return pageReport(String(message.kind ?? ""));
      case "navigationBlocked": return navigationBlocked(String(message.url ?? ""), message.reason);
      case "action": return state.actions.get(message.id)?.();
      case "menu": return menuActions[message.id]?.();
      case "link": return void openLink(String(message.url ?? ""));
      case "dialogResult": {
        const resolve = state.dialogs.get(message.id);
        state.dialogs.delete(message.id);
        return resolve?.(Number.isInteger(message.index) ? message.index : -1);
      }
      default: return undefined;
    }
  }

  return {
    receive,
    /** 壳起来时调一次：先定窗口大小（数据根还空着就开成首启那扇小窗），再走一遍 loadHome。 */
    start() {
      window(cfg.isLocal && !launcher.isInitialized() ? "setup" : "work");
      loadHome();
      setTimeout(() => {
        if (cfg.shellExe) {
          try { loginItem.reconcileAtLaunch(); } catch (error) { void alert("登录项没登记上", error.message); }
        }
        refreshLogin();
      }, 0);
    },
    stop() { resetPageConnection(); },
    state,
  };
}
