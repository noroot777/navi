// Windows 桌面版查更新、下更新（desktop/windows/launcher/updates.mjs，和它在 controller.mjs 里的接线；在 mac 上也跑）：
//   · 手动查报「已是最新」/失败原因；查到新版问三个选项，跳过的那一版自动检查不再问；装的时候盖上进度，失败了说清楚、页面回来；
//   · 查和下都有期限：壳不回话、或者一直收不到字节（不看百分比 —— 没有总长度的下载照样在报心跳）就叫壳收掉那一趟；
//   · 取消（用户点的、过了期限的）由壳裁决：它说收掉了才放开状态、页面回来；它说已经在装，就照实摆「正在安装」；
//     请求号带着这一代控制器的标识；
//   · 记不下「跳过」只说一声；换运行时、改访问设置、下更新三件事互斥（controller.mjs 的 occupied）。
// 壳那一侧（Rust，src/update.rs）的裁决靠交叉编译和真机演练核对，这里按它的协议扮演壳。
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { loadConfig } from "../desktop/windows/launcher/config.mjs";
import { createController } from "../desktop/windows/launcher/controller.mjs";
import { readSettings } from "../desktop/windows/launcher/settings.mjs";
import { createUpdates } from "../desktop/windows/launcher/updates.mjs";

reclaimScratch(tmpdir(), "navi-windows-updates-");
const temporary = realpathSync(claimScratch(tmpdir(), "navi-windows-updates-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, test, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = test();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`没等到${what}`);
    await sleep(5);
  }
}

try {
  // ── 查更新 ────────────────────────────────────────────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "updates"), NAVI_WIN_VERSION: "0.0.1" }, process.platform);
    const sent = [];
    const ui = { asked: [], alerts: [], progress: [], done: 0, answer: 1 };
    const updates = createUpdates({
      cfg, enabled: true, timing: { first: 10, interval: 10_000 },
      send: (message) => sent.push(message),
      ui: {
        log: () => {}, done: () => { ui.done += 1; }, progress: (version, progress) => ui.progress.push([version, progress.percent]),
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


  // ── 期限、心跳、壳裁决的取消、请求号分代；记不下跳过不崩；别处占着窗口时不下 ─────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "updates-limits"), NAVI_WIN_VERSION: "0.0.1" }, process.platform);
    const sent = [];
    const ui = { asked: [], alerts: [], screens: [], done: 0, answer: 0, cancel: null, busy: null };
    const updates = createUpdates({
      cfg, enabled: true, timing: { first: 10_000, check: 40, stall: 80, cancelReply: 60 },
      busy: () => ui.busy,
      send: (message) => sent.push(message),
      ui: {
        log: () => {}, done: () => { ui.done += 1; },
        progress: (version, progress, cancel) => { ui.screens.push(progress); ui.cancel = cancel; },
        ask: async (title, detail, buttons) => { ui.asked.push({ title, detail, buttons }); return ui.answer; },
        alert: async (title, detail) => { ui.alerts.push({ title, detail }); },
      },
    });
    const next = (type) => waitFor(type, () => sent.find((message) => message.type === type && !message.taken)).then((message) => { message.taken = true; return message; });
    const alerted = (title) => waitFor(title, () => ui.alerts.find((item) => item.title === title));
    const offer = async (version = "0.0.3") => {
      updates.checkNow();
      updates.receive({ type: "updateResult", id: (await next("updateCheck")).id, version });
      return next("updateInstall");
    };

    updates.checkNow();
    const silent = await next("updateCheck");
    assert.match((await alerted("检查更新没成功")).detail, /等了太久没有回音/, "壳一直不回话：按失败收场");
    updates.receive({ type: "updateResult", id: silent.id, version: "9.9.9" });
    await sleep(20);
    assert.equal(ui.asked.length, 0, "过了期限才回的答复不算数");

    // 没有总长度：只有字节心跳、没有百分比，持续收着就不算停滞
    const streaming = await offer();
    for (let i = 1; i <= 8; i++) {
      await sleep(25);
      updates.receive({ type: "updateProgress", id: streaming.id, received: i * 1024, percent: null });
    }
    assert.ok(!sent.some((message) => message.type === "updateCancel"), "一直在收字节（200 毫秒，停滞期限的两倍多）：不算没进展");
    assert.match(ui.screens.at(-1).phase, /downloading/);
    assert.equal(ui.screens.at(-1).received, 8 * 1024, "没有总长度就报收到多少");
    const stalled = await next("updateCancel");
    assert.equal(stalled.id, streaming.id, "取消带着那一趟的请求号");
    assert.equal(ui.screens.at(-1).phase, "cancelling");
    assert.equal(ui.cancel, null, "正在取消时不再给取消按钮");
    await sleep(20);
    assert.equal(ui.done, 0, "壳没裁决之前页面不回来");
    updates.receive({ type: "updateCancelResult", id: streaming.id, outcome: "cancelled" });
    assert.match((await alerted("更新没装上")).detail, /秒没有收到数据/, "停了才按失败收场");
    assert.equal(ui.done, 1);
    assert.equal(updates.installing, null);

    // 用户点取消，壳说已经在装：照实摆「正在安装」，不说取消了；装失败才回来
    ui.alerts.length = 0;
    const late = await offer();
    ui.cancel();
    assert.equal((await next("updateCancel")).id, late.id);
    updates.receive({ type: "updateCancelResult", id: late.id, outcome: "installing" });
    assert.equal(ui.screens.at(-1).phase, "installing");
    assert.equal(ui.cancel, null, "在装的时候没有取消按钮");
    await sleep(120);
    assert.equal(ui.done, 1, "在装：页面不回来、也不按停滞收掉");
    assert.ok(!ui.alerts.length);
    updates.checkNow();
    await alerted("正在更新");
    ui.alerts.length = 0;
    updates.receive({ type: "updateResult", id: late.id, error: "安装程序起不来" });
    assert.match((await alerted("更新没装上")).detail, /安装程序起不来/);
    assert.equal(ui.done, 2);

    // 用户点取消，壳收掉了：页面回来，不报失败；晚到的答复不算数
    ui.alerts.length = 0;
    const cancelled = await offer();
    ui.cancel();
    await next("updateCancel");
    updates.receive({ type: "updateCancelResult", id: cancelled.id, outcome: "cancelled" });
    await waitFor("页面回来", () => ui.done === 3);
    updates.receive({ type: "updateResult", id: cancelled.id, error: "已取消" });
    await sleep(20);
    assert.deepEqual(ui.alerts, [], "自己点的取消不报失败");

    // 壳说这一趟没了（结局在路上）：等它的结局；壳一直不答取消：过一会儿按没装上收场
    const gone = await offer();
    ui.cancel();
    await next("updateCancel");
    updates.receive({ type: "updateCancelResult", id: gone.id, outcome: "gone" });
    updates.receive({ type: "updateResult", id: gone.id, error: "签名对不上" });
    assert.match((await alerted("更新没装上")).detail, /签名对不上/);
    ui.alerts.length = 0;
    const mute = await offer();
    ui.cancel();
    await next("updateCancel");
    assert.match((await alerted("更新没装上")).detail, /壳没有回应取消/);
    assert.equal(updates.installing, null);
    assert.notEqual(mute.id, gone.id);

    // 请求号分代：另一个控制器（壳里重开的）同一个序号也认不成这一代的
    const other = [];
    const second = createUpdates({ cfg, enabled: true, timing: { check: 20 }, send: (message) => other.push(message), ui: { log() {}, alert: async () => {} } });
    second.checkNow();
    await waitFor("另一代的请求", () => other.length === 1);
    assert.notEqual(other[0].id.split("-").slice(0, 2).join("-"), mute.id.split("-").slice(0, 2).join("-"), "请求号里带着这一代控制器");

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
    assert.ok(!sent.some((message) => message.type === "updateInstall" && !message.taken), "别处占着窗口时不下更新");
    console.log("✓ 查更新、下更新有期限；停滞按收到的字节算；取消等壳裁决（收掉了才回来、在装就照实摆）；请求号分代；记不下跳过只说一声；别处占着时不下");
  }

  // ── 接进控制器：菜单、壳的答复分给 updates、下载那一屏的取消、和改访问设置互斥 ──────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "wired"), NAVI_URL: "http://127.0.0.1:14997", NAVI_WIN_VERSION: "0.0.1" }, process.platform);
    const sent = [];
    const launcher = { isInitialized: () => true, approveFreshStart() {}, ensureRunning: async () => ({ kind: "failed", message: "假的" }) };
    const controller = createController({
      cfg, launcher, updatesEnabled: true, send: (message) => sent.push(message),
      loginItem: { isEnabled: () => false, setEnabled() {}, reconcileAtLaunch: () => "skipped" },
      timing: { poll: 10_000, updates: { first: 10_000 } },
      overrides: { probeWindow: async () => ({ kind: "down" }) },
    });
    const next = (test, what) => waitFor(what, () => sent.find((message) => !message.taken && test(message))).then((message) => { message.taken = true; return message; });
    controller.start();
    controller.receive({ type: "menu", id: "checkUpdates" });
    const check = await next((message) => message.type === "updateCheck", "updateCheck");
    controller.receive({ type: "updateResult", id: check.id, version: null });
    const latest = await next((message) => message.type === "dialog" && message.title === "已经是最新版", "已是最新的对话框");
    controller.receive({ type: "dialogResult", id: latest.id, index: 0 });
    await waitFor("菜单", () => sent.find((message) => message.type === "menu"));
    assert.deepEqual(sent.find((message) => message.type === "menu").switch, { visible: false, title: "切换到新版服务…" });

    controller.receive({ type: "menu", id: "checkUpdates" });
    controller.receive({ type: "updateResult", id: (await next((message) => message.type === "updateCheck", "第二次查")).id, version: "0.0.2" });
    const offer = await next((message) => message.type === "dialog" && /0\.0\.2/.test(message.title), "更新对话框");
    controller.receive({ type: "dialogResult", id: offer.id, index: 0 });
    const install = await next((message) => message.type === "updateInstall", "updateInstall");
    controller.receive({ type: "updateProgress", id: install.id, received: 3 * 1024 * 1024, percent: null });
    const screen = await waitFor("下载那一屏", () => sent.filter((message) => message.type === "screen").at(-1)?.screen.detail.includes("已收到 3.0 MB") && sent.filter((message) => message.type === "screen").at(-1).screen);
    assert.deepEqual(screen.actions, [{ id: "cancelUpdate", title: "取消" }]);

    controller.receive({ type: "menu", id: "toggleRemote" });
    const refused = await next((message) => message.type === "dialog" && message.title === "现在改不了", "改访问设置被拦下");
    assert.match(refused.detail, /正在下载 Navi 0\.0\.2 的更新/, "下更新时不让改访问设置盖掉下载那一屏");
    controller.receive({ type: "dialogResult", id: refused.id, index: 0 });

    controller.receive({ type: "action", id: "cancelUpdate" });
    const cancel = await next((message) => message.type === "updateCancel", "updateCancel");
    assert.equal(cancel.id, install.id);
    const cancelling = sent.filter((message) => message.type === "screen").at(-1).screen;
    assert.match(cancelling.title, /正在取消/);
    assert.deepEqual(cancelling.actions, []);
    controller.receive({ type: "updateCancelResult", id: install.id, outcome: "cancelled" });
    await waitFor("页面回来", () => sent.filter((message) => message.type === "screen").at(-1)?.screen.title === "Navi 服务没起来");
    controller.stop();
    console.log("✓ 控制器：托盘「检查更新…」、答复回到 updates；下载那一屏有取消、点了等壳裁决；下更新时不让改访问设置");
  }
} finally {
  reclaimScratch(tmpdir(), "navi-windows-updates-");
}
