// Windows 桌面壳里控制器和壳之间那一来一回（desktop/windows/launcher/controller.mjs，在 mac 上也跑）：
// 假壳收消息、按剧本回 started / report / action / link / menu / dialogResult；起服务和探活换成可编排的假的。
// 覆盖首启 → 全新开始 → 认人 → 带实例号载页 → 页面表态；navi:// 在窗口里换路由或交给浏览器；页面在时端口换了人就撤页；
// 服务重起过换实例号重载；等不到页面表态时给持久说明；第一次发布时说要等几分钟；端口被占着；「允许其他设备访问」先问再重启、
// 点头之后名单变了要重问、凭冻结之下的快照停（冻不了、续不上都不停）；页面内换了地址，浏览器入口和重载都跟着它；窗口端口认不出时说清楚、不空转。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { loadConfig } from "../desktop/windows/launcher/config.mjs";
import { createController } from "../desktop/windows/launcher/controller.mjs";
import { activeHold } from "../desktop/windows/launcher/maintenance.mjs";

reclaimScratch(tmpdir(), "navi-windows-shell-controller-");
const temporary = realpathSync(claimScratch(tmpdir(), "navi-windows-shell-controller-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timing = { guard: 20, poll: 20, starting: 5, present: 80, holdRetry: 20 };

function harness(name, { initialized = true, outcome, window: windowAnswer } = {}) {
  const runtime = join(temporary, name, "runtime");
  mkdirSync(runtime, { recursive: true });
  const cfg = loadConfig({ LOCALAPPDATA: join(temporary, name), NAVI_URL: "http://127.0.0.1:14999", NAVI_WIN_RUNTIME: runtime, NAVI_WIN_SHELL: join(temporary, "Navi.exe") }, process.platform);
  mkdirSync(cfg.dataDir, { recursive: true });
  const instance = (id, extra = {}) => ({ pid: 7, id, dataDir: cfg.dataDir, codeDir: runtime, desktop: true, windowPort: cfg.windowPort, localOnly: true, tag: "ABCD-1234", ...extra });
  const h = {
    cfg, instance, sent: [], ensured: 0, approved: false, phases: [],
    outcome: outcome ?? { kind: "ready", instance: instance("one") },
    window: windowAnswer ?? { kind: "navi", instance: instance("one") },
    assess: { kind: "clear", target: { kind: "ours", pid: 7 } },
    stopped: { kind: "stopped" },
    stops: [],
    // 重启前冻结：不设 freeze 时照老版本服务走（即时再评估）；renewed 是下刀前续期的答复（null = 冻结还在）。
    freeze: null, renewed: null, renews: [], releases: [],
  };
  const launcher = {
    isInitialized: () => initialized,
    approveFreshStart: () => { h.approved = true; initialized = true; },
    async ensureRunning(_timeout, onPhase = () => {}) {
      h.ensured += 1;
      for (const phase of h.phases) onPhase(phase);
      return typeof h.outcome === "function" ? h.outcome() : h.outcome;
    },
  };
  const loginItem = { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" };
  h.controller = createController({
    cfg, launcher, loginItem, timing, send: (message) => h.sent.push(message),
    overrides: {
      probeWindow: async () => h.window,
      assess: async () => (typeof h.assess === "function" ? h.assess() : h.assess),
      freeze: async () => (h.freeze ? h.freeze() : { kind: "unfrozen", verdict: typeof h.assess === "function" ? h.assess() : h.assess }),
      renew: async (lease, agreed) => { h.renews.push(lease); h.renewAgreed = agreed; return h.renewed; },
      release: async (lease) => { h.releases.push(lease); },
      stop: async (target, options) => {
        h.stops.push(target);
        const refused = await options?.beforeKill?.();
        return refused ? { kind: "changed", why: refused } : h.stopped;
      },
    },
  });
  h.receive = (message) => h.controller.receive(message);
  h.of = (type) => h.sent.filter((message) => message.type === type);
  h.last = (type) => h.of(type).at(-1);
  h.waitFor = async (what, test, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = test();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`没等到${what}；发过的：${JSON.stringify(h.sent.map((m) => m.type === "screen" ? `screen:${m.screen.kind}:${m.screen.title ?? ""}` : m.type))}`);
      await sleep(5);
    }
  };
  h.screen = (kind, title) => h.waitFor(`${kind} ${title ?? ""}`, () => {
    const last = h.last("screen")?.screen;
    return last?.kind === kind && (!title || title.test(last.title ?? "")) ? last : null;
  });
  /** 壳按收到的 load 去载、页面开始载入并报尺寸。 */
  h.present = async (size = "work") => {
    const load = await h.waitFor("load", () => h.last("load"));
    h.receive({ type: "started", url: load.url });
    h.receive({ type: "report", kind: `size:${size}` });
    return load;
  };
  return h;
}

try {
  // ── 首启：小窗、问数据从哪来，「全新开始」后起服务、认人、带实例号载页 ─────────────
  {
    const h = harness("first", { initialized: false, outcome: { kind: "needsSetup" } });
    h.controller.start();
    assert.deepEqual(h.sent[0], { type: "window", size: "setup" }, "数据根还空着：先开成首启那扇小窗");
    const first = await h.screen("firstRun");
    assert.equal(first.dataPath, h.cfg.dataDir);
    assert.deepEqual(first.actions, [{ id: "fresh", title: "全新开始" }]);
    h.outcome = { kind: "ready", instance: h.instance("one") };
    h.receive({ type: "action", id: "fresh" });
    assert.ok(h.approved);
    assert.match((await h.screen("firstRun")).busy, /正在启动/);
    const load = await h.present("work");
    assert.equal(load.url, `${h.cfg.windowURL}/`, "载的是窗口专用端口，不是 4317");
    assert.deepEqual(load.cookie, { name: "navi_instance", value: "one" }, "先写实例号 cookie 再载");
    assert.equal(load.instance, "one", "实例号也交给壳的导航前认人");
    assert.deepEqual(h.last("window"), { type: "window", size: "work" }, "页面报了工作区尺寸就换大窗");
    assert.equal(h.controller.state.presentation, "presented");
    assert.equal(h.controller.state.screen, null, "那一屏交给了页面");
    const menu = h.last("menu");
    assert.equal(menu.remote.checked, false);
    assert.equal(menu.remote.enabled, true);
    console.log("✓ 首启：小窗问数据 → 全新开始 → 认人 → 带实例号载窗口端口 → 页面表态后换大窗");

    // navi:// 链接：指纹对上在窗口里换路由；对不上交给浏览器
    h.receive({ type: "link", url: "navi://open?project=p1&task=t1&instance=ABCD-1234" });
    const route = await h.waitFor("route", () => h.last("route"));
    assert.equal(route.route, "/?project=p1&task=t1");
    assert.ok(h.of("front").length >= 1, "链接先把窗口拉到前面");
    h.receive({ type: "link", url: "navi://open?project=p1&task=t1&instance=FFFF-0000&fallback=" + encodeURIComponent("http://mbp:4317/?project=p1&task=t1") });
    const external = await h.waitFor("openExternal", () => h.last("openExternal"));
    assert.equal(external.url, "http://mbp:4317/?project=p1&task=t1");
    console.log("✓ navi:// 指纹对上原地换路由，对不上把原来的 http 地址交给浏览器");

    // 深链换了路由，还没等页面报回：浏览器入口已经是链接那一页
    h.receive({ type: "menu", id: "openInBrowser" });
    assert.equal(h.last("openExternal").url, "http://127.0.0.1:14999/?project=p1&task=t1");

    // 菜单「在浏览器中打开」：同一路由，换成 4317 那一边
    h.receive({ type: "started", url: `${h.cfg.windowURL}/?project=before&task=old` });
    h.receive({ type: "report", kind: "titlebar" });
    // 页面内切到别的项目（History API，不换文档）：报回的地址才是用户此刻在看的；别的来源报来的不认
    h.receive({ type: "report", kind: `url:${h.cfg.windowURL}/?project=p1#x` });
    h.receive({ type: "report", kind: "url:http://evil.example/?project=p1" });
    h.receive({ type: "menu", id: "openInBrowser" });
    assert.equal(h.last("openExternal").url, "http://127.0.0.1:14999/?project=p1#x");

    // 服务重起过（还是自己那份，实例号换了）：换上新实例号原地重载
    h.window = { kind: "navi", instance: h.instance("two") };
    const reload = await h.waitFor("换实例号的 load", () => h.of("load").find((m) => m.cookie?.value === "two"));
    assert.equal(reload.url, `${h.cfg.windowURL}/?project=p1#x`, "重载回原来的路由");
    console.log("✓ 在浏览器中打开换成 4317 的同一路由；服务重起过换实例号原地重载");

    // 端口换了人：撤页（空白屏）、记下路由、回去认一遍；这回被别人占着就说清楚
    h.outcome = { kind: "occupied", message: "14999 端口上已经有一份 Navi 在跑" };
    h.window = { kind: "navi", instance: h.instance("x", { dataDir: join(temporary, "other") }) };
    await h.waitFor("空白屏", () => h.of("screen").some((m) => m.screen.kind === "blank"));
    const occupied = await h.screen("offline", /14999 端口被占着/);
    assert.match(occupied.detail, /已经有一份 Navi/);
    assert.deepEqual(occupied.actions.map((a) => a.id), ["retry"]);
    assert.equal(h.controller.state.resumeURL, `${h.cfg.windowURL}/?project=p1#x`, "认回来之后回到原来的路由");
    h.controller.stop();
    console.log("✓ 页面在时端口换了人：先撤页再认人，被占着时说清楚、记着路由");
  }

  // ── 页面载进来却迟迟不表态：持久说明，「仍然显示页面」再载一次 ───────────────────
  {
    const h = harness("silent");
    h.controller.start();
    const load = await h.waitFor("load", () => h.last("load"));
    h.receive({ type: "started", url: load.url });
    const silent = await h.screen("offline", /页面没有显示出来/);
    assert.deepEqual(silent.actions.map((a) => a.id), ["showAnyway", "retry"]);
    const loads = h.of("load").length;
    h.receive({ type: "action", id: "showAnyway" });
    assert.equal(h.of("load").length, loads + 1);
    h.receive({ type: "started", url: load.url });
    h.receive({ type: "report", kind: "broken:/assets/index.js" });
    h.controller.stop();
    console.log("✓ 等不到页面表态：换上持久说明，可以仍然显示或重试");
  }

  // ── 第一次发布运行时：说要等几分钟（首启那一屏里也说） ─────────────────────────
  {
    const h = harness("publish");
    h.phases = ["publishing"];
    let finish;
    h.outcome = () => new Promise((resolve) => { finish = resolve; });
    h.controller.start();
    const preparing = await h.screen("offline", /正在准备 Navi/);
    assert.match(preparing.detail, /几分钟/);
    assert.equal(preparing.busy, true);
    finish({ kind: "ready", instance: h.instance("one") });
    await h.present();
    h.controller.stop();

    const f = harness("publish-first", { initialized: false, outcome: { kind: "needsSetup" } });
    f.controller.start();
    await f.screen("firstRun");
    f.phases = ["publishing"];
    f.outcome = () => new Promise(() => {});
    f.receive({ type: "action", id: "fresh" });
    await f.waitFor("首启屏里的准备说明", () => /第一次要几分钟/.test(f.last("screen").screen.busy ?? ""));
    f.controller.stop();
    console.log("✓ 第一次发布运行时：说明要等几分钟（首启屏里同样说）");
  }

  // ── 服务起不来：说原因，给日志和重试 ─────────────────────────────────────────
  {
    const h = harness("failed", { outcome: { kind: "failed", message: "服务进程 9 起来就退出了" } });
    h.controller.start();
    const failed = await h.screen("offline", /Navi 服务没起来/);
    assert.match(failed.detail, /起来就退出了/);
    assert.deepEqual(failed.actions.map((a) => a.id), ["logs", "retry"]);
    h.receive({ type: "action", id: "logs" });
    assert.equal(h.last("openPath").path, h.cfg.logsDir);
    h.controller.stop();
  }

  // ── 允许其他设备访问：先问会打断谁，放行后停评估过的那一份、确认停下才落设置，再起 ───────
  {
    const h = harness("remote");
    h.controller.start();
    await h.present();
    h.assess = { kind: "disrupts", target: { kind: "ours", pid: 7 }, items: [{ title: "任务 A", why: "正在跑" }] };
    h.receive({ type: "menu", id: "toggleRemote" });
    const dialog = await h.waitFor("确认框", () => h.last("dialog"));
    assert.match(dialog.title, /允许其他设备访问/);
    assert.match(dialog.detail, /任务 A —— 正在跑/);
    assert.match(dialog.detail, /Windows 防火墙/);
    assert.deepEqual(dialog.buttons, ["打开并重启服务", "取消"]);
    assert.equal(h.last("menu").remote.enabled, false, "切换途中点不动");
    h.receive({ type: "dialogResult", id: dialog.id, index: 1 });
    await h.waitFor("菜单恢复", () => h.last("menu").remote.enabled === true);
    assert.equal(h.stops.length, 0, "取消了就什么都不动");

    const ensured = h.ensured;
    h.receive({ type: "menu", id: "toggleRemote" });
    const again = await h.waitFor("第二个确认框", () => h.of("dialog").find((m) => m.id !== dialog.id));
    h.outcome = { kind: "ready", instance: h.instance("three", { localOnly: false }) };
    h.window = { kind: "navi", instance: h.instance("three", { localOnly: false }) };
    h.receive({ type: "dialogResult", id: again.id, index: 0 });
    await h.waitFor("重启后重新载页", () => h.of("load").some((m) => m.cookie?.value === "three"));
    assert.deepEqual(h.stops, [{ kind: "ours", pid: 7 }], "只停评估过的那一份");
    assert.equal(JSON.parse(readFileSync(h.cfg.settingsFile, "utf8")).allowOtherDevices, true);
    assert.ok(h.ensured > ensured, "按新设置再起");
    const menu = h.last("menu");
    assert.equal(menu.remote.checked, true);
    assert.equal(menu.remote.title, "允许其他设备访问");

    // 改回只听本机、又不打断谁：收窄不用问，直接办。这回没停成：设置不改、说清楚
    h.stopped = { kind: "failed", why: "进程不肯退" };
    h.assess = { kind: "clear", target: { kind: "ours", pid: 7 } };
    const asked = h.of("dialog").length;
    h.receive({ type: "menu", id: "toggleRemote" });
    const refusal = await h.waitFor("没切换的说明", () => h.of("dialog").find((m) => m.title === "没有切换"));
    assert.match(refusal.detail, /进程不肯退[\s\S]*设置没改/);
    assert.equal(h.of("dialog").length, asked + 1, "收窄且不打断谁时没有先问");
    assert.equal(JSON.parse(readFileSync(h.cfg.settingsFile, "utf8")).allowOtherDevices, true, "没停成就不改设置");
    const loads = h.of("load").length;
    h.receive({ type: "dialogResult", id: refusal.id, index: 0 });
    await h.waitFor("说明关掉后回到页面", () => h.of("load").length > loads);
    h.controller.stop();
    console.log("✓ 允许其他设备访问：先问（列出会打断的、提醒防火墙），取消不动，放行后只停那一份、停下才落设置；改回本机不打断谁就不问，没停成不改设置");
  }

  // ── 点头之后、停服务之前名单变了：松锁重问，取消就什么都不动；同意了新名单才停 ───────────
  {
    const h = harness("remote-changed");
    h.controller.start();
    await h.present();
    const verdicts = [
      { kind: "clear", target: { kind: "ours", pid: 7 } },
      { kind: "disrupts", target: { kind: "ours", pid: 7 }, items: [{ id: "n", title: "新任务", why: "会被判失败" }] },
    ];
    h.assess = () => verdicts.shift() ?? { kind: "disrupts", target: { kind: "ours", pid: 7 }, items: [{ id: "n", title: "新任务", why: "会被判失败" }] };
    h.receive({ type: "menu", id: "toggleRemote" });
    const first = await h.waitFor("确认框", () => h.last("dialog"));
    assert.match(first.detail, /照常接着跑/);
    h.receive({ type: "dialogResult", id: first.id, index: 0 });
    const again = await h.waitFor("重问", () => h.of("dialog").find((m) => m.id !== first.id));
    assert.match(again.detail, /确认之后情况变了[\s\S]*新任务 —— 会被判失败/);
    assert.equal(h.stops.length, 0, "名单变了，没停");
    assert.equal(activeHold(h.cfg), null, "重问时维护锁已经松开");
    const loads = h.of("load").length;
    h.receive({ type: "dialogResult", id: again.id, index: 1 });
    await h.waitFor("取消后回到页面", () => h.of("load").length > loads);
    assert.equal(h.stops.length, 0, "取消了就不停");
    assert.equal(existsSync(h.cfg.settingsFile), false, "设置没改");
    assert.equal(h.last("menu").remote.enabled, true);

    // 再来一次：重问时同意，按同意过的那一份停
    verdicts.push({ kind: "clear", target: { kind: "ours", pid: 7 } });
    h.receive({ type: "menu", id: "toggleRemote" });
    const third = await h.waitFor("第三个确认框", () => h.of("dialog").find((m) => m.id > again.id));
    h.receive({ type: "dialogResult", id: third.id, index: 0 });
    const fourth = await h.waitFor("又一次重问", () => h.of("dialog").find((m) => m.id > third.id));
    h.receive({ type: "dialogResult", id: fourth.id, index: 0 });
    await h.waitFor("停了", () => h.stops.length === 1);
    assert.equal(JSON.parse(readFileSync(h.cfg.settingsFile, "utf8")).allowOtherDevices, true);
    await h.waitFor("重新载页", () => h.of("load").length > loads + 1);
    h.controller.stop();
    console.log("✓ 点头之后名单变了：松锁重问，取消什么都不动，同意了才停、才落设置");
  }

  // ── 重启前冻结：凭冻结之下的快照停、下刀前续期；快照多出来的放开冻结重问；冻不了、续不上都不改设置 ───────
  {
    const h = harness("remote-freeze");
    h.controller.start();
    await h.present();
    const ours = (items) => (items ? { kind: "disrupts", target: { kind: "ours", pid: 7 }, items, instance: "one", freezable: true }
      : { kind: "clear", target: { kind: "ours", pid: 7 }, instance: "one", freezable: true });
    const settings = () => (existsSync(h.cfg.settingsFile) ? JSON.parse(readFileSync(h.cfg.settingsFile, "utf8")).allowOtherDevices : undefined);

    // 冻不了：不停、不改设置，原因原样说出来
    h.assess = ours();
    h.freeze = () => ({ kind: "refused", why: "另一处正在准备重启服务" });
    h.receive({ type: "menu", id: "toggleRemote" });
    let dialog = await h.waitFor("确认框", () => h.last("dialog"));
    assert.doesNotMatch(dialog.detail, /不支持重启前冻结/, "认冻结的服务不提这句");
    h.receive({ type: "dialogResult", id: dialog.id, index: 0 });
    let refusal = await h.waitFor("没切换的说明", () => h.of("dialog").find((m) => m.title === "没有切换"));
    assert.match(refusal.detail, /冻结不了接活（另一处正在准备重启服务）[\s\S]*设置没改/);
    assert.equal(h.stops.length, 0, "冻不了就不停");
    assert.equal(settings(), undefined);
    h.receive({ type: "dialogResult", id: refusal.id, index: 0 });
    await h.waitFor("菜单恢复", () => h.last("menu").remote.enabled === true);

    // 冻结之下多出了一个：放开冻结、松锁重问；取消就什么都不动
    const lease = { token: "lease-1" };
    h.freeze = () => ({ kind: "frozen", lease, verdict: ours([{ id: "late", title: "冻结时才看到的任务", why: "会被判失败：正在起跑" }]) });
    h.receive({ type: "menu", id: "toggleRemote" });
    dialog = await h.waitFor("确认框", () => h.of("dialog").find((m) => m.id > refusal.id));
    h.receive({ type: "dialogResult", id: dialog.id, index: 0 });
    const again = await h.waitFor("重问", () => h.of("dialog").find((m) => m.id > dialog.id));
    assert.match(again.detail, /确认之后情况变了[\s\S]*冻结时才看到的任务/);
    assert.deepEqual(h.releases, [lease], "重问之前冻结当场放开，不让它冻着等用户");
    assert.equal(activeHold(h.cfg), null, "重问时维护锁已经松开");
    assert.equal(h.stops.length, 0);
    const loads = h.of("load").length;
    h.receive({ type: "dialogResult", id: again.id, index: 1 });
    await h.waitFor("取消后回到页面", () => h.of("load").length > loads);
    assert.equal(settings(), undefined);

    // 下刀前续期没续上：不停、放开冻结、不改设置
    h.releases = [];
    h.freeze = () => ({ kind: "frozen", lease, verdict: ours() });
    h.renewed = "冻结已经失效（到期了，或者被放掉了）";
    h.receive({ type: "menu", id: "toggleRemote" });
    dialog = await h.waitFor("确认框", () => h.of("dialog").find((m) => m.id > again.id));
    h.receive({ type: "dialogResult", id: dialog.id, index: 0 });
    refusal = await h.waitFor("没切换的说明", () => h.of("dialog").find((m) => m.id > dialog.id && m.title === "没有切换"));
    assert.match(refusal.detail, /冻结已经失效/);
    assert.deepEqual(h.renews, [lease], "下刀前续了一次期");
    assert.deepEqual(h.releases, [lease], "没停成就放开冻结");
    assert.equal(settings(), undefined, "没停成就不改设置");
    h.receive({ type: "dialogResult", id: refusal.id, index: 0 });
    await h.waitFor("菜单恢复", () => h.last("menu").remote.enabled === true);

    // 冻住了、名单没多：续期之后停，停成了不再放（服务退了冻结跟着没了），落设置
    h.renews = [];
    h.releases = [];
    h.renewed = null;
    h.stops = [];
    h.receive({ type: "menu", id: "toggleRemote" });
    dialog = await h.waitFor("确认框", () => h.of("dialog").find((m) => m.id > refusal.id));
    h.receive({ type: "dialogResult", id: dialog.id, index: 0 });
    await h.waitFor("停了", () => h.stops.length === 1 && settings() === true);
    assert.deepEqual(h.renews, [lease]);
    assert.equal(h.renewAgreed?.target?.kind, "ours", "续期拿用户点头的那份判断去比此刻的名单");
    assert.deepEqual(h.releases, [], "停成了不用放");
    h.controller.stop();

    // 老版本服务（判据里没有协议号）：确认框里如实说这一下堵不上
    const old = harness("remote-old-server");
    old.controller.start();
    await old.present();
    old.assess = { kind: "clear", target: { kind: "ours", pid: 7 }, instance: "one", freezable: false };
    old.receive({ type: "menu", id: "toggleRemote" });
    const told = await old.waitFor("确认框", () => old.last("dialog"));
    assert.match(told.detail, /这一版服务不支持重启前冻结/);
    old.receive({ type: "dialogResult", id: told.id, index: 1 });
    await old.waitFor("菜单恢复", () => old.last("menu").remote.enabled === true);
    old.controller.stop();
    console.log("✓ 重启前冻结：冻不了不停，快照多出来的放开冻结重问，续不上不停，冻住且没多才停；老版本服务如实说堵不上");
  }

  // ── 主端口好好的、窗口端口认不出：说清楚，隔一阵探一次，通了再载；不一圈圈地重起 ─────────
  {
    const h = harness("window-port", { window: { kind: "down" } });
    h.controller.start();
    const stuck = await h.screen("offline", /窗口连不上 Navi/);
    assert.match(stuck.detail, new RegExp(`${h.cfg.windowPort} 端口上却认不出它：没有程序在听`));
    assert.deepEqual(stuck.actions.map((a) => a.id), ["logs", "retry"]);
    await sleep(150);
    assert.equal(h.ensured, 1, "没有回头一遍遍地起服务");
    h.window = { kind: "navi", instance: h.instance("one") };
    await h.present();
    assert.equal(h.controller.state.presentation, "presented");
    h.controller.stop();
    console.log("✓ 窗口端口认不出：持久说明、按轮询间隔再探，通了自动载页，不空转");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
