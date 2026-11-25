// Windows 桌面版装了新版之后的两件事（desktop/windows/launcher/handover.mjs、updates.mjs、db-backup.mjs，在 mac 上也跑）：
//   · 换运行时：服务还在旧运行时上就等；旧服务报了接不住的回合、或者终端 / 项目服务还开着，就不停它；都空了才
//     攥锁 → 拿许可（带 holdResources）→ 给库留底 → 兑现许可 → 只停那一份 → 窗口重连。哪一步不成都不停、归还许可；
//     连着拿不到许可就停下等用户；用户从菜单「现在切换」要先看会打断谁，点了才不等 —— 点的是那一份服务、那一张名单，
//     锁里再核一遍，变了就重新问；新版运行时没发布好强制也不切；在下更新时不切。
//   · 查更新：手动查报「已是最新」/失败原因；查到新版问三个选项，跳过的那一版自动检查不再问；装的时候盖上进度，失败了说清楚、页面回来；
//     查和下都有期限、能取消，过了头放开状态；记不下「跳过」也不崩；正在切换服务时不下。
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
    valid: true, stopped: { kind: "stopped" }, backup: () => join(cfg.dataDir, "backups", "x.db"), answer: 0, answers: [],
    onAsk: () => {}, publishError: null, busy: null,
  };
  r.handover = createHandover({
    cfg,
    timing: { poll: 15 },
    busy: () => r.busy,
    ui: {
      log: (line) => r.logs.push(line), menu: () => {}, hold: (title) => r.held.push(title), release: () => { r.released += 1; },
      ask: async (title, detail, buttons) => {
        r.asked.push({ title, detail, buttons });
        r.calls.push("ask");
        r.onAsk(r.asked.length);
        return r.answers.length ? r.answers.shift() : r.answer;
      },
      alert: async (title, detail) => { r.alerts.push({ title, detail }); },
    },
    overrides: {
      probe: async () => r.health,
      publish: async () => {
        r.calls.push("publish");
        if (r.publishError) throw new Error(r.publishError);
        return runtime(join(cfg.runtimeStore, NEW), NEW, { ".handover.json": COMPAT });
      },
      impact: async (id, compat) => { r.calls.push(`impact:${id}:${compat.schema}`); return typeof r.impact === "function" ? r.impact() : { impact: r.impact }; },
      handover: async (id, body) => {
        r.calls.push(`handover:${JSON.stringify(body)}`);
        if (body.release) return { released: true };
        if (body.commit) return { committed: r.valid };
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
  r.sequence = () => r.calls.filter((call) => !call.startsWith("publish") && !call.startsWith("impact") && call !== "ask");
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
      shutdown: { resources: [{ kind: "terminal", id: "s1", label: "PowerShell" }, { kind: "preview-trial", id: "9", label: "预览试跑 C:\\p" }] },
    }, COMPAT);
    assert.deepEqual(found.items.map((item) => item.title), ["排队的任务", "终端「PowerShell」", "预览试跑 C:\\p"], "终端的会话名单看认不出，带上是终端");
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
    r.impact = { runtimeHandover: { blocked: [], target: COMPAT }, shutdown: { resources: [{ kind: "terminal", id: "s1", label: "ping -t" }] } };
    r.handover.observe(r.health.instance);
    await waitFor("问过两次", () => r.calls.filter((call) => call.startsWith("impact")).length >= 2);
    assert.equal(r.handover.state.phase, "waiting");
    assert.equal(r.handover.menu().visible, true, "等的时候菜单里有「切换到新版服务…」");
    assert.deepEqual(r.sequence(), [], "终端开着：不拿许可、不停服务");
    assert.equal(r.handover.state.items[0].title, "终端「ping -t」");
    r.impact = { runtimeHandover: { blocked: [], target: COMPAT }, shutdown: { resources: [] } };
    await waitFor("换完", () => r.released === 1);
    assert.equal(r.handover.state.phase, "idle");
    assert.deepEqual(r.sequence(), [
      `handover:${JSON.stringify({ ...COMPAT, holdResources: true })}`,
      `backup:${OLD.slice(0, 12)}`,
      'handover:{"commit":"L1"}',
      "stop:41",
    ], "许可 → 留底 → 兑现 → 停，许可带着 holdResources");
    assert.ok(r.calls.some((call) => call === `impact:old-1:${COMPAT.schema}`), "带着认过的实例号和新版 schema 问");
    assert.equal(activeHold(r.cfg), null, "换完松开维护锁，窗口重连时用新版起");
    assert.deepEqual(r.held, ["正在切换到新版 Navi 服务"]);
    console.log("✓ 换运行时：终端开着就留在旧服务上等；都空了才许可 → 留底 → 兑现 → 只停那一份，松锁后重连");
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
    console.log("✓ 拿不到许可、留底失败、许可兑现不了：一律不停旧服务并归还许可；连着 4 次拿不到就停下，菜单留重试");
  }

  // ── 用户从菜单要现在切换：先看会打断谁，点了才不等 ──────────────────────
  {
    const r = rig("force");
    r.impact = { runtimeHandover: { blocked: [{ id: "t9", title: "调度台", reason: "调度台当前回合不能无损接管" }], target: COMPAT }, shutdown: { resources: [] } };
    r.handover.observe(r.health.instance);
    await waitFor("在等", () => r.handover.state.items.length === 1);
    r.answer = 1;
    r.handover.reconsider();
    await waitFor("问了一次", () => r.asked.length === 1);
    assert.match(r.asked[0].detail, /调度台 —— 调度台当前回合不能无损接管/);
    assert.deepEqual(r.asked[0].buttons, ["现在切换", "继续等"], "关掉对话框按最后一个算：继续等");
    await sleep(30);
    assert.ok(!r.calls.some((call) => call.startsWith("stop")), "选继续等：不停");
    assert.equal(r.handover.state.phase, "waiting");
    r.answer = 0;
    r.handover.reconsider();
    await waitFor("强制换完", () => r.released === 1);
    assert.deepEqual(r.sequence(), [`backup:${OLD.slice(0, 12)}`, "stop:41"], "用户点了现在切换：不要许可，照样先留底");
    const tail = r.calls.slice(r.calls.lastIndexOf("ask"));
    assert.ok(tail.indexOf("publish") > 0, "点了之后、停之前重新发布一遍新版");
    assert.ok(tail.lastIndexOf(`impact:old-1:${COMPAT.schema}`) > tail.indexOf(`backup:${OLD.slice(0, 12)}`), "留底之后、停之前再核一遍名单");
    console.log("✓ 菜单「切换到新版服务…」：列出会打断的，关掉对话框就是继续等；点了现在切换才不等许可，照样先给库留底");
  }

  // ── 强制切换只认用户点的那一份、那一张：变了就重新问 ────────────────────
  {
    const blocked = { blocked: [{ id: "t9", title: "调度台", reason: "调度台当前回合不能无损接管" }], target: COMPAT };
    const w = rig("force-widened");
    w.impact = { runtimeHandover: blocked, shutdown: { resources: [] } };
    w.onAsk = (count) => {
      if (count === 1) w.impact = { runtimeHandover: blocked, shutdown: { resources: [{ kind: "terminal", id: "s2", label: "cargo watch" }] } };
    };
    w.answers = [0, 1];
    w.handover.observe(w.health.instance);
    await waitFor("在等", () => w.handover.state.items.length === 1);
    w.handover.reconsider();
    await waitFor("又问了一次", () => w.asked.length === 2);
    await sleep(30);
    assert.match(w.asked[1].detail, /情况变了/);
    assert.match(w.asked[1].detail, /终端「cargo watch」/, "新冒出来的那个摆给用户看");
    assert.ok(!w.calls.some((call) => call.startsWith("stop")), "名单比确认时多了：不停");
    assert.deepEqual(w.alerts, [], "不是失败，是重新问");
    assert.equal(activeHold(w.cfg), null, "没停也松开维护锁");
    assert.equal(w.handover.state.phase, "waiting");
    w.handover.stop();

    const n = rig("force-new-instance");
    n.impact = { runtimeHandover: blocked, shutdown: { resources: [] } };
    n.onAsk = (count) => { if (count === 1) n.health = { kind: "navi", instance: n.instance(n.oldDir, { id: "old-2", pid: 42 }) }; };
    n.handover.observe(n.health.instance);
    await waitFor("在等", () => n.handover.state.items.length === 1);
    n.handover.reconsider();
    await waitFor("换完", () => n.calls.some((call) => call.startsWith("stop")));
    assert.equal(n.asked.length, 2, "端口上换了一份服务：先对着新的那份再问一次");
    assert.deepEqual(n.calls.filter((call) => call.startsWith("stop")), ["stop:42"], "停的是用户第二次确认的那份");
    n.handover.stop();

    const u = rig("force-unknown");
    u.impact = () => ({ error: "超时" });
    u.handover.observe(u.health.instance);
    await waitFor("确认不了", () => u.handover.state.why?.includes("超时"));
    u.handover.reconsider();
    await waitFor("换完", () => u.calls.includes("stop:41"));
    assert.match(u.asked[0].detail, /确认不了.*按会打断对待/);
    assert.equal(u.asked.length, 1, "对着「确认不了」点的：按全都会打断算，锁里不再拿名单比");
    console.log("✓ 强制切换：锁里再核实例和名单，换了服务或者多了没确认过的就不停、重新问；对着「确认不了」点的照切");
  }

  // ── 新版运行时没发布好：强制也不切，说清楚 ───────────────────────────────
  {
    const r = rig("unprepared");
    r.publishError = "校验失败：server/dist/index.js 对不上";
    r.handover.observe(r.health.instance);
    await waitFor("记下原因", () => r.handover.state.why?.includes("对不上"));
    r.handover.reconsider();
    await waitFor("说明", () => r.alerts.length === 1);
    assert.equal(r.alerts[0].title, "现在切换不了");
    assert.match(r.alerts[0].detail, /新版运行时没准备好：校验失败/);
    assert.equal(r.asked.length, 0, "不是会打断谁的问题：不给「现在切换」");
    assert.deepEqual(r.sequence(), [], "不攥锁、不留底、不停");
    r.handover.stop();

    const p = rig("republish-fails");
    p.impact = { runtimeHandover: { blocked: [{ id: "t9", title: "调度台", reason: "x" }], target: COMPAT }, shutdown: { resources: [] } };
    p.onAsk = () => { p.publishError = "磁盘满了"; };
    p.handover.observe(p.health.instance);
    await waitFor("在等", () => p.handover.state.items.length === 1);
    p.handover.reconsider();
    await waitFor("说明", () => p.alerts.length === 1);
    assert.equal(p.alerts[0].title, "没有切换");
    assert.match(p.alerts[0].detail, /新版运行时没准备好：磁盘满了[\s\S]*旧服务照常在跑/);
    assert.deepEqual(p.sequence(), [], "确认之后发布失败：旧服务不停");
    assert.equal(p.released, 1, "页面回来");
    p.handover.stop();
    console.log("✓ 新版运行时没发布好（一开始就不行、或者点了之后才不行）：强制也不切，旧服务照常，说清楚原因");
  }

  // ── 在下更新时不切 ─────────────────────────────────────────────────────
  {
    const r = rig("busy-updating");
    r.busy = "正在下载 Navi 0.0.2 的更新";
    r.handover.observe(r.health.instance);
    await waitFor("记下原因", () => r.handover.state.why?.includes("下载"));
    assert.deepEqual(r.sequence(), [], "在下更新：不拿许可、不碰窗口");
    assert.deepEqual(r.held, []);
    r.handover.reconsider();
    await waitFor("说明", () => r.alerts.length === 1);
    assert.match(r.alerts[0].detail, /正在下载/);
    r.busy = null;
    await waitFor("下完了接着换", () => r.calls.includes("stop:41"));
    console.log("✓ 在下更新时不切换服务（两边都要占窗口那一屏），下完了照常换");
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

    ui.answer = 1;
    updates.checkNow();
    await reply({ version: "0.0.2", notes: "修了几处" });
    await waitFor("问了", () => ui.asked.length === 1);
    assert.deepEqual(ui.asked[0].buttons, ["现在更新", "跳过这一版", "以后再说"], "关掉对话框按最后一个算：以后再说");
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

  // ── 查更新、下更新都有头，能取消；记不下跳过不崩；切换服务时不下 ──────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "updates-limits"), NAVI_WIN_VERSION: "0.0.1" }, process.platform);
    const sent = [];
    const ui = { asked: [], alerts: [], progress: [], done: 0, answer: 0, cancel: null, busy: null };
    const updates = createUpdates({
      cfg, enabled: true, timing: { first: 10_000, check: 40, stall: 60 },
      busy: () => ui.busy,
      send: (message) => sent.push(message),
      ui: {
        log: () => {}, done: () => { ui.done += 1; },
        progress: (version, percent, cancel) => { ui.progress.push([version, percent]); ui.cancel = cancel; },
        ask: async (title, detail, buttons) => { ui.asked.push({ title, detail, buttons }); return ui.answer; },
        alert: async (title, detail) => { ui.alerts.push({ title, detail }); },
      },
    });
    const next = (type) => waitFor(type, () => sent.find((message) => message.type === type && !message.taken)).then((message) => { message.taken = true; return message; });
    const alerted = (title) => waitFor(title, () => ui.alerts.find((item) => item.title === title));

    updates.checkNow();
    const silent = await next("updateCheck");
    assert.match((await alerted("检查更新没成功")).detail, /等了太久没有回音/, "壳一直不回话：按失败收场");
    updates.receive({ type: "updateResult", id: silent.id, version: "9.9.9" });
    await sleep(20);
    assert.equal(ui.asked.length, 0, "过了期限才回的答复不算数");
    updates.checkNow();
    updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version: null });
    await alerted("已经是最新版");

    updates.checkNow();
    updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version: "0.0.3" });
    const stalled = await next("updateInstall");
    updates.receive({ type: "updateProgress", id: stalled.id, percent: 10 });
    assert.match((await alerted("更新没装上")).detail, /秒没有进展/, "下载一直没进展：按失败收场");
    assert.ok(sent.some((message) => message.type === "updateCancel"), "叫壳收掉那一趟");
    assert.equal(updates.installing, null, "状态放开了");
    assert.equal(ui.done, 1, "页面回来");

    ui.alerts.length = 0;
    updates.checkNow();
    updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version: "0.0.3" });
    const cancelled = await next("updateInstall");
    updates.checkNow();
    await alerted("正在更新");
    assert.equal(sent.filter((message) => message.type === "updateCheck").length, 4, "在下的时候手动查：说一声，不另查");
    ui.cancel();
    await waitFor("页面回来", () => ui.done === 2);
    assert.equal(sent.filter((message) => message.type === "updateCancel").length, 2);
    updates.receive({ type: "updateResult", id: cancelled.id, error: "已取消，没有装。" });
    await sleep(20);
    assert.ok(!ui.alerts.some((item) => item.title === "更新没装上"), "自己点的取消不再报失败");
    assert.equal(updates.installing, null);

    mkdirSync(cfg.settingsFile, { recursive: true });
    ui.answer = 1;
    updates.checkNow();
    updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version: "0.0.3" });
    assert.ok((await alerted("没记住跳过这一版")).detail.includes("0.0.3"), "记不下跳过：说一声，控制器不崩");

    ui.answer = 0;
    ui.busy = "正在切换到新版服务";
    updates.checkNow();
    updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version: "0.0.3" });
    assert.match((await alerted("现在不能更新")).detail, /正在切换到新版服务/);
    assert.ok(!sent.some((message) => message.type === "updateInstall" && !message.taken), "切换服务时不下更新");
    console.log("✓ 查更新、下更新有期限，过了头或点取消都放开状态、页面回来、叫壳收掉；记不下「跳过」只说一声；切换服务时不下");
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
