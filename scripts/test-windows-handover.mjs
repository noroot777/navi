// Windows 桌面版装了新版之后换到新运行时（desktop/windows/launcher/handover.mjs、db-backup.mjs，在 mac 上也跑；
// 查更新、下更新在 test-windows-updates.mjs）：
//   · 服务还在旧运行时上就等；旧服务报了接不住的回合、或者终端 / 项目服务还开着，就不停它；都空了才
//     攥锁 → 拿许可（带 holdResources）→ 给库留底 → 兑现许可（旧服务自己下线）→ 等它退干净 → 窗口重连。哪一步不成都不停、
//     归还许可；连着拿不到许可就停下等用户；用户从菜单「现在切换」要先看会打断谁，点了才不等 —— 点的是那一份服务、那一张
//     名单，锁里再核一遍，变了就重新问；新版运行时没发布好强制也不切；在下更新时不切。
//   · 壳在切换途中退出：控制器先把这一趟做完，旧服务交出去了就把新版起起来再退。
//   · 留底用 SQLite 在线备份，WAL 里没并进主文件的也在，只留 5 份。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { loadConfig } from "../desktop/windows/launcher/config.mjs";
import { createController } from "../desktop/windows/launcher/controller.mjs";
import { backupDatabase, KEEP } from "../desktop/windows/launcher/db-backup.mjs";
import { blockersOf, compatibilityOf, createHandover } from "../desktop/windows/launcher/handover.mjs";
import { noteUnfinished } from "../desktop/windows/launcher/handover-duty.mjs";
import { activeHold, beginMaintenance } from "../desktop/windows/launcher/maintenance.mjs";

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
function rig(name, timing = {}) {
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
    onAsk: () => {}, publishError: null, busy: null, stopGate: null, alive: true, releaseAnswer: { released: true },
  };
  r.overrides = {
    probe: async () => r.health,
    publish: async () => {
      r.calls.push("publish");
      if (r.publishError) throw new Error(r.publishError);
      return runtime(join(cfg.runtimeStore, NEW), NEW, { ".handover.json": COMPAT });
    },
    impact: async (id, compat) => { r.calls.push(`impact:${id}:${compat.schema}`); return typeof r.impact === "function" ? r.impact() : { impact: r.impact }; },
    handover: async (id, body) => {
      r.calls.push(`handover:${JSON.stringify(body)}`);
      if (body.release) return r.releaseAnswer;
      if (body.commit) return r.commitAnswer ? r.commitAnswer() : { committed: r.valid };
      return r.grant();
    },
    stop: async (target) => {
      r.calls.push(`stop:${target.pid}`);
      assert.ok(activeHold(cfg), "停服务时攥着维护锁");
      await r.stopGate;
      return r.stopped;
    },
    backup: async (from) => { r.calls.push(`backup:${from}`); return r.backup(); },
    alive: () => r.alive,
    begin: (note) => (r.begin ? r.begin(note) : beginMaintenance(cfg, note, 50_000)),
  };
  r.handover = createHandover({
    cfg,
    timing: { poll: 15, ...timing },
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
    overrides: r.overrides,
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
    assert.equal(v.handover.successorPending(), false, "服务端明说兑现不了：旧服务原样在，不欠起新版");
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

  // ── 起新版的责任：撤不回的那一步之前就记下，亲眼看到结果才结清 ───────────────
  {
    const fresh = (r) => r.instance(join(r.cfg.runtimeStore, NEW), { id: "new-1", pid: 77 });

    const commits = (r) => r.calls.filter((call) => call.startsWith('handover:{"commit"')).length;
    const fenced = { lease: 40, answer: 20, beat: 5 }; // 许可 40 毫秒后到期，过了再给 20 毫秒答话

    // 兑现发出去了、答复丢了，旧服务的进程已经没了：照样算停了，欠着起新版
    const lost = rig("commit-lost-gone", { beat: 5 });
    lost.commitAnswer = () => { lost.health = { kind: "down" }; lost.alive = false; return { error: "socket hang up" }; };
    lost.handover.observe(lost.health.instance);
    await waitFor("换完", () => lost.released === 1);
    assert.ok(lost.calls.includes("stop:41"), "进程没了，再核一遍它退干净了");
    assert.equal(lost.handover.state.phase, "idle");
    assert.equal(lost.handover.successorPending(), true, "答复丢了不等于没兑现：起新版的责任还在");
    lost.handover.observe(lost.instance(lost.oldDir));
    assert.equal(lost.handover.successorPending(), true, "看到的还是交出去的那一份：不算结清");
    lost.handover.observe(fresh(lost));
    assert.equal(lost.handover.successorPending(), false, "看到新版才结清");

    // 兑现一直没答复（503、探活也探不到）：只接着问，问不到答案绝不去停它；它回来答话、亲口说没兑现才结清
    const mute = rig("commit-unknown", fenced);
    mute.releaseAnswer = { error: "服务端回 503" };
    mute.commitAnswer = () => { mute.health = { kind: "unreachable", reason: "503" }; return { error: "服务端回 503" }; };
    mute.handover.observe(mute.health.instance);
    await waitFor("没切换", () => mute.handover.state.why?.includes("问不到结果"));
    assert.ok(!mute.calls.some((call) => call.startsWith("stop")), "探不到它不等于它下线了，更不等于可以停它");
    assert.ok(commits(mute) >= 2, "兑现是幂等的：没答复就接着问");
    assert.equal(mute.handover.successorPending(), true, "结果不明：责任留着");
    mute.handover.stop();
    await sleep(60);
    assert.equal(mute.handover.successorPending(), true, "过了多久都不靠计时结清");
    mute.health = { kind: "navi", instance: mute.instance(mute.oldDir) };
    mute.commitAnswer = () => ({ committed: false });
    mute.handover.observe(mute.health.instance);
    await waitFor("问到它没兑现", () => !mute.handover.successorPending());
    assert.ok(mute.logs.some((line) => line.includes("说许可没兑现")));
    mute.handover.stop();

    // 在途的那次兑现晚到、真执行了：它回来答话时一问是「兑现过」，接着欠着，退出前一直起到新版
    const late = rig("commit-late", fenced);
    late.releaseAnswer = { released: false };
    late.commitAnswer = () => ({ error: "timeout" });
    late.handover.observe(late.health.instance);
    await waitFor("没切换", () => late.handover.state.why?.includes("问不到结果"));
    late.handover.stop();
    late.commitAnswer = () => ({ committed: true });
    const asked = commits(late);
    late.handover.observe(late.health.instance);
    await waitFor("又问了一次", () => late.handover.state.asking === false && commits(late) === asked + 1);
    await sleep(20);
    assert.equal(late.handover.successorPending(), true, "它说兑现过（正在退）：不结清");
    late.handover.stop();
    let lateTries = 0;
    const settled = await late.handover.discharge(async () => (++lateTries < 3 ? { kind: "ready", instance: late.health.instance } : { kind: "ready", instance: fresh(late) }));
    assert.deepEqual(settled, { ok: true }, "旧的那份退了、新版起来才算完");
    assert.equal(lateTries, 3);

    // 归还许可成功 = 旧服务亲口说没兑现、也再兑现不了：结清
    const back = rig("commit-unknown-released", fenced);
    back.commitAnswer = () => ({ error: "timeout" });
    back.handover.observe(back.health.instance);
    await waitFor("没切换", () => back.handover.state.why?.includes("问不到结果"));
    assert.ok(back.calls.includes('handover:{"release":"L1"}'));
    assert.equal(back.handover.successorPending(), false);
    back.handover.stop();

    // 停完松锁出错：这一趟照样收尾，欠的起新版不丢
    const lock = rig("end-throws");
    lock.begin = async (note) => {
      const end = await beginMaintenance(lock.cfg, note, 50_000);
      return () => { end(); throw new Error("维护标记删不掉"); };
    };
    lock.handover.observe(lock.health.instance);
    await waitFor("换完", () => lock.released === 1);
    assert.ok(lock.logs.some((line) => line.includes("松开维护锁出错：维护标记删不掉")));
    assert.equal(await lock.handover.settled(), null, "收尾不会抛出去");
    assert.equal(lock.handover.successorPending(), true);

    // 强制切换：停是撤不回的。停的结果不明（超时）也欠着；还没动手就发现不对，不欠
    const forced = rig("force-stop-failed");
    forced.impact = { runtimeHandover: { blocked: [{ id: "t9", title: "调度台", reason: "x" }], target: COMPAT }, shutdown: { resources: [] } };
    forced.stopped = { kind: "failed", why: "服务进程 41 20 秒内没有退出" };
    forced.handover.observe(forced.health.instance);
    await waitFor("在等", () => forced.handover.state.items.length === 1);
    forced.handover.reconsider();
    await waitFor("说明", () => forced.alerts.length === 1);
    assert.equal(forced.handover.successorPending(), true, "已经动手停了：不管结局都欠着起新版");
    forced.handover.stop();
    const early = rig("force-stop-changed");
    early.impact = forced.impact;
    early.stopped = { kind: "changed", why: "端口上换成了别的 Navi" };
    early.handover.observe(early.health.instance);
    await waitFor("在等", () => early.handover.state.items.length === 1);
    early.handover.reconsider();
    await waitFor("说明", () => early.alerts.length === 1);
    assert.equal(early.handover.successorPending(), false, "停之前就发现不对、什么都没动：不欠");
    early.handover.stop();

    // 退出前结清：起不来就一直起，起到新版为止；限时内起不来就交回原因
    const owed = rig("discharge", { discharge: 200, retry: 10 });
    owed.handover.observe(owed.health.instance);
    await waitFor("换完", () => owed.released === 1);
    let tries = 0;
    assert.deepEqual(await owed.handover.discharge(async () => (++tries < 3 ? { kind: "failed", message: "端口被占" } : { kind: "ready", instance: fresh(owed) })), { ok: true });
    assert.equal(tries, 3, "起不来就再起");
    const stuck = rig("discharge-fails", { discharge: 60, retry: 10 });
    stuck.handover.observe(stuck.health.instance);
    await waitFor("换完", () => stuck.released === 1);
    assert.deepEqual(await stuck.handover.discharge(async () => ({ kind: "failed", message: "端口被占" })), { ok: false, why: "端口被占" });
    // 每一次起都只给剩下的时间：卡住不回的那一次也不会把整趟拖过时限
    const given = [];
    const began = Date.now();
    assert.deepEqual(await stuck.handover.discharge((left) => { given.push(left); return new Promise(() => {}); }), { ok: false, why: "等过了时限" });
    assert.ok(Date.now() - began < 1_000 && given.length === 1 && given[0] <= 60, "交给 ensureRunning 的期限是剩下的时间，到点不等它");
    // 强制切换没有许可可问：旧服务还在答话就照实说停没停下不明，不空转到时限
    const unsure = rig("discharge-forced", { discharge: 5_000, retry: 10 });
    unsure.impact = forced.impact;
    unsure.stopped = { kind: "failed", why: "服务进程 41 20 秒内没有退出" };
    unsure.handover.observe(unsure.health.instance);
    await waitFor("在等", () => unsure.handover.state.items.length === 1);
    unsure.handover.reconsider();
    await waitFor("说明", () => unsure.alerts.length === 1);
    unsure.handover.stop();
    const quick = Date.now();
    const verdict = await unsure.handover.discharge(async () => ({ kind: "ready", instance: unsure.health.instance }));
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /停没停下不明/);
    assert.ok(Date.now() - quick < 1_000);
    console.log("✓ 起新版的责任：兑现、强停之前就记下；兑现结果不明只接着问、绝不去停，看到新版或者旧服务亲口说没兑现才结清（晚到的兑现执行了也接得住）；松锁出错不丢；退出前在时限里一直起到新版");
  }

  // ── 壳在切换途中退出：控制器先把这一趟做完，旧服务交出去了就把新版起起来再退 ────────
  {
    const r = rig("shutdown-mid-switch");
    let open;
    r.stopGate = new Promise((resolve) => { open = resolve; });
    const fresh = r.instance(join(r.cfg.runtimeStore, NEW), { id: "new-1", pid: 77 });
    const events = [];
    let starts = 0;
    const launcher = {
      isInitialized: () => true, approveFreshStart() {},
      ensureRunning: async () => {
        starts += 1;
        events.push(`ensure:${starts}`);
        return { kind: "ready", instance: r.calls.includes("stop:41") ? fresh : r.health.instance };
      },
    };
    const lines = [];
    const controller = createController({
      cfg: r.cfg, launcher, updatesEnabled: false, send: () => {}, log: (line) => lines.push(line),
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, handover: 15, updates: { first: 10_000 } },
      overrides: { handover: r.overrides, probeWindow: async () => ({ kind: "down" }) },
    });
    controller.start();
    await waitFor("开始停旧服务", () => r.calls.includes("stop:41"));
    assert.ok(r.calls.includes('handover:{"commit":"L1"}'), "许可已经兑现：旧服务正在自己下线");
    const before = starts;
    let finished = false;
    const shutdown = controller.shutdown().then(() => { finished = true; events.push("shutdown"); });
    await sleep(40);
    assert.equal(finished, false, "这一趟没做完不退");
    events.push("stopped");
    open();
    await shutdown;
    assert.ok(starts > before, "旧服务停了：退出前把新版起起来");
    assert.ok(lines.some((line) => line.includes("先把新版服务起起来")) && lines.some((line) => line.includes("新版服务起来了")),
      "是退出这一步自己起的新版，不靠窗口那边重连");
    assert.ok(events.indexOf("stopped") < events.lastIndexOf(`ensure:${starts}`), "起新版在旧服务停下之后");
    assert.equal(activeHold(r.cfg), null, "松开了维护锁");
    controller.stop(); // 真退出时 controller-main 接着就 exit；这里替它收掉窗口那边重连起的计时器

    const idle = rig("shutdown-idle");
    let idleStarts = 0;
    const quiet = createController({
      cfg: idle.cfg, updatesEnabled: false, send: () => {},
      launcher: { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => { idleStarts += 1; return { kind: "failed", message: "假的" }; } },
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, updates: { first: 10_000 } },
      overrides: { handover: idle.overrides, probeWindow: async () => ({ kind: "down" }) },
    });
    quiet.start();
    await waitFor("起来时连一次", () => idleStarts === 1);
    await quiet.shutdown();
    assert.equal(idleStarts, 1, "没在切换：直接退，不碰服务");

    const failing = rig("shutdown-note");
    const sentNotes = [];
    const broken = createController({
      cfg: failing.cfg, updatesEnabled: false, send: () => {},
      launcher: { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => (failing.calls.includes("stop:41") ? { kind: "failed", message: "新版起不来：端口被占" } : { kind: "ready", instance: failing.health.instance }) },
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, handover: 15, handoverTiming: { discharge: 50, retry: 10 }, updates: { first: 10_000 } },
      overrides: { handover: failing.overrides, probeWindow: async () => ({ kind: "down" }) },
    });
    broken.start();
    await waitFor("停了旧服务", () => failing.calls.includes("stop:41"));
    await sleep(20);
    await broken.shutdown();
    broken.stop();
    const reopened = createController({
      cfg: failing.cfg, updatesEnabled: false, send: (message) => sentNotes.push(message),
      launcher: { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => ({ kind: "failed", message: "假的" }) },
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, updates: { first: 10_000 } },
      overrides: { probeWindow: async () => ({ kind: "down" }) },
    });
    const notePath = join(dirname(failing.cfg.settingsFile), "handover-unfinished.json");
    assert.ok(existsSync(notePath), "留了纸条");
    reopened.start();
    const told = await waitFor("下次打开时说一声", () => sentNotes.find((message) => message.type === "dialog" && message.title === "上次退出时新版服务没起来"));
    assert.match(told.detail, /新版起不来：端口被占[\s\S]*也还没起来/, "照这次起服务的结局说");
    assert.ok(existsSync(notePath), "用户还没看过：纸条留着");
    reopened.receive({ type: "dialogResult", id: told.id, index: 0 });
    await waitFor("说过了删纸条", () => !existsSync(notePath));
    reopened.stop();
    noteUnfinished(failing.cfg, "上次的原因");
    const shown = [];
    const fine = createController({
      cfg: failing.cfg, updatesEnabled: false, send: (message) => shown.push(message),
      launcher: { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => ({ kind: "ready", instance: failing.instance(join(failing.cfg.runtimeStore, NEW), { id: "new-1", pid: 77 }) }) },
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, updates: { first: 10_000 } },
      overrides: { probeWindow: async () => ({ kind: "down" }) },
    });
    fine.start();
    const ready = await waitFor("起来了再说", () => shown.find((message) => message.type === "dialog" && message.title === "上次退出时新版服务没起来"));
    assert.match(ready.detail, /上次的原因[\s\S]*已经起来了/);
    fine.stop();
    console.log("✓ 壳在切换途中退出：等这一趟做完，旧服务交出去了就把新版起起来再退；起不来留纸条、下次打开说给用户；没在切换就直接退");
  }

} finally {
  reclaimScratch(tmpdir(), "navi-windows-handover-");
}
