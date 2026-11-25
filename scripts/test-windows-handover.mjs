// Windows 桌面版装了新版之后的两件事（desktop/windows/launcher/handover.mjs、updates.mjs、db-backup.mjs，在 mac 上也跑）：
//   · 换运行时：服务还在旧运行时上就等；旧服务报了接不住的回合、或者终端 / 项目服务还开着，就不停它；都空了才
//     攥锁 → 拿许可（带 holdResources）→ 给库留底 → 核对许可 → 只停那一份 → 窗口重连。哪一步不成都不停、归还许可；
//     连着拿不到许可就停下等用户；用户从菜单「现在切换」要先看会打断谁，点了才不等。
//   · 查更新：手动查报「已是最新」/失败原因；查到新版问三个选项，跳过的那一版自动检查不再问；装的时候盖上进度，失败了说清楚、页面回来。
//   · 留底用 SQLite 在线备份，WAL 里没并进主文件的也在，只留 5 份。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { loadConfig } from "../desktop/windows/launcher/config.mjs";
import { createController } from "../desktop/windows/launcher/controller.mjs";
import { backupDatabase, KEEP } from "../desktop/windows/launcher/db-backup.mjs";
import { blockersOf, compatibilityOf, createHandover } from "../desktop/windows/launcher/handover.mjs";
import { activeHold } from "../desktop/windows/launcher/maintenance.mjs";
import { readSettings } from "../desktop/windows/launcher/settings.mjs";
import { createUpdates } from "../desktop/windows/launcher/updates.mjs";

reclaimScratch(tmpdir(), "navi-windows-handover-");
const temporary = realpathSync(claimScratch(tmpdir(), "navi-windows-handover-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const COMPAT = { protocol: 1, schema: "schema-2" };

async function waitFor(what, test, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = test();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`没等到${what}`);
    await sleep(5);
  }
}

function runtime(dir, id, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".runtime.json"), JSON.stringify({ format: 2, platform: "win32", id }));
  for (const [name, value] of Object.entries(extra)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

/** 一套假的：运行时仓库里有旧版那份，安装目录里是新版发布源；旧服务的答复、许可、停服务、留底都可编排。 */
function rig(name) {
  const home = join(temporary, name);
  const bundled = runtime(join(home, "Programs", "Navi", "runtime"), NEW, { ".handover.json": COMPAT });
  const cfg = loadConfig({ LOCALAPPDATA: home, NAVI_URL: "http://127.0.0.1:14998", NAVI_WIN_RUNTIME: bundled }, process.platform);
  mkdirSync(cfg.dataDir, { recursive: true });
  const oldDir = runtime(join(cfg.runtimeStore, OLD), OLD);
  const instance = (codeDir, extra = {}) => ({ pid: 41, id: "old-1", dataDir: cfg.dataDir, codeDir, desktop: true, windowPort: cfg.windowPort, localOnly: true, tag: "T", ...extra });
  const r = {
    cfg, oldDir, instance, calls: [], logs: [], asked: [], alerts: [], released: 0, held: [],
    health: { kind: "navi", instance: instance(oldDir) },
    impact: { runtimeHandover: { blocked: [], target: COMPAT }, shutdown: { resources: [] } },
    grant: () => ({ lease: "L1", protocol: 1 }),
    valid: true, stopped: { kind: "stopped" }, backup: () => join(cfg.dataDir, "backups", "x.db"), answer: 0,
  };
  r.handover = createHandover({
    cfg,
    timing: { poll: 15 },
    ui: {
      log: (line) => r.logs.push(line), menu: () => {}, hold: (title) => r.held.push(title), release: () => { r.released += 1; },
      ask: async (title, detail, buttons) => { r.asked.push({ title, detail, buttons }); return r.answer; },
      alert: async (title, detail) => { r.alerts.push({ title, detail }); },
    },
    overrides: {
      probe: async () => r.health,
      publish: async () => {
        r.calls.push("publish");
        return runtime(join(cfg.runtimeStore, NEW), NEW, { ".handover.json": COMPAT });
      },
      impact: async (id, compat) => { r.calls.push(`impact:${id}:${compat.schema}`); return typeof r.impact === "function" ? r.impact() : { impact: r.impact }; },
      handover: async (id, body) => {
        r.calls.push(`handover:${JSON.stringify(body)}`);
        if (body.release) return { released: true };
        if (body.check) return { valid: r.valid };
        return r.grant();
      },
      stop: async (target) => {
        r.calls.push(`stop:${target.pid}`);
        assert.ok(activeHold(cfg), "停服务时攥着维护锁");
        return r.stopped;
      },
      backup: async (from) => { r.calls.push(`backup:${from}`); return r.backup(); },
    },
  });
  r.sequence = () => r.calls.filter((call) => !call.startsWith("publish") && !call.startsWith("impact"));
  return r;
}

try {
  // ── 读答复 ────────────────────────────────────────────────────────────
  {
    const dir = runtime(join(temporary, "compat"), NEW, { ".handover.json": COMPAT });
    assert.deepEqual(compatibilityOf(dir), COMPAT);
    assert.equal(compatibilityOf(runtime(join(temporary, "compat-old"), OLD)), null, "没带 .handover.json 的认不出");
    assert.match(blockersOf({}, COMPAT).unknown, /没报能不能交接/);
    assert.match(blockersOf({ runtimeHandover: { blocked: [], target: { protocol: 1, schema: "other" } }, shutdown: { resources: [] } }, COMPAT).unknown, /兼容性/);
    assert.match(blockersOf({ runtimeHandover: { blocked: [], target: COMPAT } }, COMPAT).unknown, /终端/, "旧服务没报随它停的东西：不当成没有");
    const found = blockersOf({
      runtimeHandover: { blocked: [{ id: "t1", title: "排队的任务", reason: "排队中" }], target: COMPAT },
      shutdown: { resources: [{ kind: "terminal", id: "s1", label: "终端 · npm run dev" }] },
    }, COMPAT);
    assert.deepEqual(found.items.map((item) => item.title), ["排队的任务", "终端 · npm run dev"]);
    assert.match(found.items[1].why, /一停它就没了/);
    console.log("✓ 新版的接管协议从 .handover.json 读；接不住的回合和终端 / 项目服务都算要等的，答复不全按确认不了");
  }

  // ── 已经在新版上 / 不是运行时仓库里的那份：不动 ─────────────────────────
  {
    const r = rig("current");
    r.handover.observe(r.instance(join(r.cfg.runtimeStore, NEW)));
    r.handover.observe(r.instance(r.cfg.bundledRuntime));
    await sleep(40);
    assert.equal(r.handover.state.phase, "idle");
    assert.deepEqual(r.calls, []);
    assert.equal(r.handover.menu().visible, false);
    console.log("✓ 服务已经跑在新运行时上（或直接从发布源跑）时不问也不换");
  }

  // ── 终端开着就等；关了才按顺序换 ─────────────────────────────────────────
  {
    const r = rig("wait-then-switch");
    r.impact = { runtimeHandover: { blocked: [], target: COMPAT }, shutdown: { resources: [{ kind: "terminal", id: "s1", label: "终端 · ping -t" }] } };
    r.handover.observe(r.health.instance);
    await waitFor("问过两次", () => r.calls.filter((call) => call.startsWith("impact")).length >= 2);
    assert.equal(r.handover.state.phase, "waiting");
    assert.equal(r.handover.menu().visible, true, "等的时候菜单里有「切换到新版服务…」");
    assert.deepEqual(r.sequence(), [], "终端开着：不拿许可、不停服务");
    assert.equal(r.handover.state.items[0].title, "终端 · ping -t");
    r.impact = { runtimeHandover: { blocked: [], target: COMPAT }, shutdown: { resources: [] } };
    await waitFor("换完", () => r.released === 1);
    assert.equal(r.handover.state.phase, "idle");
    assert.deepEqual(r.sequence(), [
      `handover:${JSON.stringify({ ...COMPAT, holdResources: true })}`,
      `backup:${OLD.slice(0, 12)}`,
      'handover:{"check":"L1"}',
      "stop:41",
    ], "许可 → 留底 → 核对 → 停，许可带着 holdResources");
    assert.ok(r.calls.some((call) => call === `impact:old-1:${COMPAT.schema}`), "带着认过的实例号和新版 schema 问");
    assert.equal(activeHold(r.cfg), null, "换完松开维护锁，窗口重连时用新版起");
    assert.deepEqual(r.held, ["正在切换到新版 Navi 服务"]);
    console.log("✓ 换运行时：终端开着就留在旧服务上等；都空了才许可 → 留底 → 核对 → 只停那一份，松锁后重连");
  }

  // ── 哪一步不成都不停，归还许可；连着拿不到许可就停下等用户 ──────────────
  {
    const r = rig("refused");
    r.grant = () => ({ error: "仍在使用：终端 · vim" });
    r.handover.observe(r.health.instance);
    await waitFor("停下自动切换", () => r.handover.state.phase === "blocked", 4_000);
    assert.equal(r.handover.state.failures, 4);
    assert.ok(!r.calls.some((call) => call.startsWith("stop")), "拿不到许可就不停");
    assert.equal(r.handover.menu().title, "重试切换到新版服务…");
    assert.equal(r.released, 4, "每次没换成都把窗口接回来");
    assert.ok(r.logs.some((line) => /不再自动试/.test(line)));

    const b = rig("backup-fails");
    b.backup = () => { throw new Error("磁盘满了"); };
    b.handover.observe(b.health.instance);
    await waitFor("留底失败", () => b.handover.state.why?.includes("磁盘满了"));
    assert.ok(!b.calls.some((call) => call.startsWith("stop")), "留底失败不停");
    assert.ok(b.calls.includes('handover:{"release":"L1"}'), "没换成就把许可还回去（旧服务解封）");
    b.handover.stop();

    const v = rig("lease-expired");
    v.valid = false;
    v.handover.observe(v.health.instance);
    await waitFor("许可失效", () => v.handover.state.why?.includes("失效"));
    assert.ok(!v.calls.some((call) => call.startsWith("stop")));
    v.handover.stop();
    console.log("✓ 拿不到许可、留底失败、许可失效：一律不停旧服务并归还许可；连着 4 次拿不到就停下，菜单留重试");
  }

  // ── 用户从菜单要现在切换：先看会打断谁，点了才不等 ──────────────────────
  {
    const r = rig("force");
    r.impact = { runtimeHandover: { blocked: [{ id: "t9", title: "调度台", reason: "调度台当前回合不能无损接管" }], target: COMPAT }, shutdown: { resources: [] } };
    r.handover.observe(r.health.instance);
    await waitFor("在等", () => r.handover.state.items.length === 1);
    r.answer = 0;
    r.handover.reconsider();
    await waitFor("问了一次", () => r.asked.length === 1);
    assert.match(r.asked[0].detail, /调度台 —— 调度台当前回合不能无损接管/);
    assert.deepEqual(r.asked[0].buttons, ["继续等", "现在切换"], "默认是继续等");
    await sleep(30);
    assert.ok(!r.calls.some((call) => call.startsWith("stop")), "选继续等：不停");
    assert.equal(r.handover.state.phase, "waiting");
    r.answer = 1;
    r.handover.reconsider();
    await waitFor("强制换完", () => r.released === 1);
    assert.deepEqual(r.sequence(), [`backup:${OLD.slice(0, 12)}`, "stop:41"], "用户点了现在切换：不要许可，照样先留底");
    console.log("✓ 菜单「切换到新版服务…」：列出会打断的，默认继续等；点了现在切换才不等许可，照样先给库留底");
  }

  // ── 留底：SQLite 在线备份，WAL 里的也在，只留 5 份 ──────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "backup") }, process.platform);
    mkdirSync(cfg.dataDir, { recursive: true });
    assert.equal(await backupDatabase(cfg, "old"), null, "还没有库：不用备");
    const db = new DatabaseSync(join(cfg.dataDir, "navi.db"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v); INSERT INTO t VALUES ('写在 WAL 里')");
    assert.ok(existsSync(join(cfg.dataDir, "navi.db-wal")));
    const made = [];
    for (let i = 0; i < KEEP + 2; i += 1) made.push(await backupDatabase(cfg, OLD.slice(0, 12), { now: new Date(Date.UTC(2026, 10, 25, 1, 2, i)) }));
    db.close();
    const copy = new DatabaseSync(made.at(-1), { readOnly: true });
    assert.equal(copy.prepare("SELECT v FROM t").get().v, "写在 WAL 里", "开着的库也备得全");
    copy.close();
    const kept = readdirSync(join(cfg.dataDir, "backups")).filter((name) => name.endsWith(".db")); // 打开过的那份旁边会多出 -wal/-shm
    assert.equal(kept.length, KEEP, "只留 5 份");
    assert.ok(!kept.includes(made[0].split(/[\\/]/).at(-1)), "删的是最早的");
    assert.match(made.at(-1), /20261125-010206-win-aaaaaaaaaaaa\.db$/);
    console.log("✓ 切换前留底：SQLite 在线备份（WAL 里的也在），按时间命名，只留最近 5 份");
  }

  // ── 查更新 ────────────────────────────────────────────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "updates"), NAVI_WIN_VERSION: "0.0.1" }, process.platform);
    const sent = [];
    const ui = { asked: [], alerts: [], progress: [], done: 0, answer: 1 };
    const updates = createUpdates({
      cfg, enabled: true, timing: { first: 10, interval: 10_000 },
      send: (message) => sent.push(message),
      ui: {
        log: () => {}, done: () => { ui.done += 1; }, progress: (version, percent) => ui.progress.push([version, percent]),
        ask: async (title, detail, buttons) => { ui.asked.push({ title, detail, buttons }); return ui.answer; },
        alert: async (title) => { ui.alerts.push(title); },
      },
    });
    const reply = async (body) => {
      const request = await waitFor("一条请求", () => sent.find((message) => !message.answered));
      request.answered = true;
      updates.receive({ type: "updateResult", id: request.id, ...body });
      return request;
    };

    updates.checkNow();
    assert.equal((await reply({ version: null })).type, "updateCheck");
    await waitFor("已是最新", () => ui.alerts.includes("已经是最新版"));

    updates.checkNow();
    await reply({ error: "网络不通" });
    await waitFor("失败原因", () => ui.alerts.includes("检查更新没成功"));

    ui.answer = 2;
    updates.checkNow();
    await reply({ version: "0.0.2", notes: "修了几处" });
    await waitFor("问了", () => ui.asked.length === 1);
    assert.deepEqual(ui.asked[0].buttons, ["现在更新", "以后再说", "跳过这一版"]);
    assert.match(ui.asked[0].detail, /现在是 0\.0\.1。\n\n修了几处/);
    assert.match(ui.asked[0].detail, /服务和任务都不停/);
    await waitFor("记下跳过", () => readSettings(cfg).skippedVersion === "0.0.2");

    updates.start();
    await reply({ version: "0.0.2" });
    await sleep(30);
    assert.equal(ui.asked.length, 1, "自动检查不再问跳过的那一版");
    updates.stop();

    ui.answer = 0;
    updates.checkNow();
    await reply({ version: "0.0.2" });
    const install = await waitFor("装", () => sent.find((message) => message.type === "updateInstall"));
    assert.equal(install.version, "0.0.2", "手动检查照样摆出跳过的那一版，点了就装");
    updates.receive({ type: "updateProgress", id: install.id, percent: 40 });
    assert.deepEqual(ui.progress, [["0.0.2", null], ["0.0.2", 40]]);
    install.answered = true;
    updates.receive({ type: "updateResult", id: install.id, error: "签名对不上" });
    await waitFor("装失败", () => ui.alerts.includes("更新没装上"));
    assert.equal(ui.done, 1, "没装上：页面回来");

    const off = [];
    const plain = createUpdates({ cfg, enabled: false, send: (message) => off.push(message), ui: { log() {}, alert: async (title) => off.push(title) } });
    plain.start();
    plain.checkNow();
    await waitFor("没带更新源", () => off.includes("这一版不自动更新"));
    assert.ok(!off.some((message) => message.type), "没带更新源的构建一条请求都不发");
    console.log("✓ 查更新：已是最新 / 失败说原因；三个选项，跳过的自动检查不再问；装时盖进度，失败了说清楚、页面回来");
  }

  // ── 接进控制器：菜单两项、壳的答复分给 updates ─────────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "wired"), NAVI_URL: "http://127.0.0.1:14997" }, process.platform);
    const sent = [];
    const launcher = { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => ({ kind: "failed", message: "假的" }) };
    const controller = createController({
      cfg, launcher, updatesEnabled: true, send: (message) => sent.push(message),
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, updates: { first: 10_000 } },
      overrides: { probeWindow: async () => ({ kind: "down" }) },
    });
    controller.start();
    controller.receive({ type: "menu", id: "checkUpdates" });
    const check = await waitFor("updateCheck", () => sent.find((message) => message.type === "updateCheck"));
    controller.receive({ type: "updateResult", id: check.id, version: null });
    await waitFor("已是最新的对话框", () => sent.find((message) => message.type === "dialog" && message.title === "已经是最新版"));
    await waitFor("菜单", () => sent.find((message) => message.type === "menu"));
    assert.deepEqual(sent.find((message) => message.type === "menu").switch, { visible: false, title: "切换到新版服务…" });
    controller.stop();
    console.log("✓ 控制器：托盘「检查更新…」发 updateCheck、答复回到 updates；菜单带上「切换到新版服务…」的状态");
  }
} finally {
  reclaimScratch(tmpdir(), "navi-windows-handover-");
}
