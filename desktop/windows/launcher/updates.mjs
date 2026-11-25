// 什么时候查更新、问不问、装不装（对应 mac 的 Updater.swift；查、下、验签、交给安装包在壳里，见 shell/src/update.rs）。
//
// 带更新源的构建（NAVI_WIN_UPDATES=1）起来 1 分钟后查一次，之后每 6 小时一次；托盘「检查更新…」随时查。
// 查到新版就问用户：「现在更新」「跳过这一版」「以后再说」（关掉对话框按最后一个算）（记在 settings.json 的 skippedVersion，自动检查不再问它，
// 手动检查照样摆出来）。点了「现在更新」窗口盖上下载进度，下完壳把安装包交给系统、自己退出，安装包装完重开 Navi。
// 换的只是壳：服务和 agent 不停，新壳起来后再按 handover.mjs 换到新运行时。
//
// 每一步都有头（壳里查 30 秒、下 15 分钟、300 MB，见 update.rs）；这里再兜一层：壳那边过了头还没回话、或者下载一分半
// 没收到一个字节（壳收到字节就报，有没有总长度都报），就叫壳收掉那一趟。下载那一屏的「取消」走同一条路。
// 取消是壳裁决的（updateCancel → updateCancelResult）：它说收掉了才放开状态、页面回来；它说已经在装，就照实
// 摆「正在安装」，不说取消了。请求号带着这一代控制器的标识：重开的控制器认不成上一代那一趟的答复。
// 别处占着窗口那一屏（换运行时、按新设置重启服务，controller.mjs 的 occupied）时不下。
import { randomBytes } from "node:crypto";
import { readSettings, writeSettings } from "./settings.mjs";

export const FIRST_CHECK_MS = 60_000;
export const INTERVAL_MS = 6 * 60 * 60_000;
export const CHECK_LIMIT_MS = 60_000;
export const INSTALL_LIMIT_MS = 16 * 60_000;
export const STALL_LIMIT_MS = 90_000;
export const CANCEL_REPLY_MS = 15_000;

export function createUpdates({ cfg, send, ui, enabled = process.env.NAVI_WIN_UPDATES === "1", busy = () => null, timing = {} }) {
  const t = { first: FIRST_CHECK_MS, interval: INTERVAL_MS, check: CHECK_LIMIT_MS, install: INSTALL_LIMIT_MS, stall: STALL_LIMIT_MS, cancelReply: CANCEL_REPLY_MS, ...timing };
  const state = { serial: 0, generation: randomBytes(4).toString("hex"), pending: new Map(), timer: null, busy: false, installing: null, download: null };

  /** 发给壳、等它回话；给了 limitMs，到了还没回就按 { error, timedOut } 收场。返回 { id, done, settle }。 */
  function request(message, limitMs = null) {
    const id = `u-${state.generation}-${++state.serial}`;
    let settle;
    const done = new Promise((resolve) => {
      const timer = limitMs === null ? null : setTimeout(() => settle({ error: "等了太久没有回音", timedOut: true }), limitMs);
      settle = (answer) => {
        if (!state.pending.has(id)) return;
        clearTimeout(timer);
        state.pending.delete(id);
        resolve(answer);
      };
      state.pending.set(id, settle);
    });
    send({ ...message, id });
    return { id, done, settle };
  }

  function schedule(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { void check({ manual: false }).finally(() => schedule(t.interval)); }, delay);
  }

  async function check({ manual }) {
    if (!enabled) {
      if (manual) await ui.alert("这一版不自动更新", "这份 Navi 没带更新源（开发时的便携版）。装正式的安装包才会自动更新。");
      return;
    }
    if (state.installing) {
      if (manual) await ui.alert("正在更新", `正在下载 Navi ${state.installing}，下载那一屏上可以取消。`);
      return;
    }
    if (state.busy) return;
    state.busy = true;
    try {
      const found = await request({ type: "updateCheck" }, t.check).done;
      if (found.error) {
        ui.log(`检查更新失败：${found.error}`);
        if (manual) await ui.alert("检查更新没成功", `${found.error}\n\n过一会儿再试；网络通了也会每 6 小时自动查一次。`);
        return;
      }
      if (!found.version) {
        if (manual) await ui.alert("已经是最新版", `Navi ${cfg.version} 就是最新的。`);
        return;
      }
      if (!manual && readSettings(cfg).skippedVersion === found.version) return ui.log(`有新版 ${found.version}，用户跳过了这一版`);
      const notes = String(found.notes ?? "").trim();
      const detail = [
        `现在是 ${cfg.version}。${notes ? `\n\n${notes.slice(0, 1200)}` : ""}`,
        "更新只换窗口这一层，几十秒就好：在跑的服务和任务都不停，装好后等它们都能交接了再切到新版服务。",
      ].join("\n\n");
      const choice = await ui.ask(`Navi ${found.version} 可以更新了`, detail, ["现在更新", "跳过这一版", "以后再说"]);
      if (choice === 1) skip(found.version);
      if (choice === 0) await install(found.version);
    } finally {
      state.busy = false;
    }
  }

  function skip(version) {
    try { writeSettings(cfg, { skippedVersion: version }); }
    catch (error) {
      ui.log(`记不下跳过的 ${version}：${error.message}`);
      void ui.alert("没记住跳过这一版", `${error.message}\n\n下次自动检查还会问到 ${version}。`);
    }
  }

  async function install(version) {
    const other = busy();
    if (other) return void await ui.alert("现在不能更新", `${other}，等它完了再从托盘菜单「检查更新…」更新。`);
    state.installing = version;
    const download = { ...request({ type: "updateInstall", version }), version, received: 0, percent: null, phase: "downloading", stall: null, reply: null, aborting: null };
    state.download = download;
    // 到了总时限：还在下就叫壳收掉；已经在装（取消不了）还没有结局，就不再等它了。
    const limit = setTimeout(() => (download.phase === "installing" ? download.settle({ error: "安装一直没有结束" }) : abandon("下载超过了时限")), t.install);
    beat();
    const result = await download.done;
    // 装成了走不到这里：壳把安装包交出去就退出了。回来的只有失败、超时和取消 —— 都是壳认过的结局。
    clearTimeout(limit);
    clearTimeout(download.stall);
    clearTimeout(download.reply);
    state.download = null;
    state.installing = null;
    ui.done();
    if (result.cancelled) return ui.log(`取消了更新到 ${version}`);
    ui.log(`更新到 ${version} 没装上：${result.error}`);
    await ui.alert("更新没装上", `${result.error || "原因不明"}\n\n现在的版本照常能用，可以稍后从托盘菜单「检查更新…」再试。`);
  }

  /** 照现在的阶段画那一屏；还在下的时候顺带重新计「没进展」的时。 */
  function beat() {
    const download = state.download;
    clearTimeout(download.stall);
    if (download.phase === "downloading" && !download.aborting) {
      download.stall = setTimeout(() => abandon(`下载 ${Math.round(t.stall / 1000)} 秒没有收到数据`), t.stall);
    }
    ui.progress(download.version, {
      phase: download.aborting ? "cancelling" : download.phase,
      percent: download.percent,
      received: download.received,
    }, download.phase === "downloading" && !download.aborting ? cancel : null);
  }

  /** 叫壳收掉这一趟，等它裁决（updateCancelResult）。user：是用户点的取消，不是过了期限。 */
  function abandon(why, { user = false } = {}) {
    const download = state.download;
    if (!download || download.aborting || download.phase !== "downloading") return;
    download.aborting = { why, user };
    send({ type: "updateCancel", id: download.id });
    // 壳一直不答（它多半已经没了）：不能一直挂着那一屏。
    download.reply = setTimeout(() => download.settle({ error: `${why}；壳没有回应取消` }), t.cancelReply);
    beat();
  }

  function cancel() { abandon("已取消", { user: true }); }

  function decided(download, outcome) {
    const { why, user } = download.aborting ?? {};
    if (outcome === "cancelled") return download.settle({ error: why, cancelled: user });
    clearTimeout(download.reply);
    download.aborting = null;
    if (outcome === "installing") {
      download.phase = "installing";
      ui.log(`要取消更新时已经在装了：${why}`);
      return beat();
    }
    // gone：壳那边这一趟已经结束了，它的结局（updateResult）就在路上；再等一会儿，还没有就按没装上收场。
    download.reply = setTimeout(() => download.settle({ error: why }), t.cancelReply);
  }

  function receive(message) {
    const download = state.download;
    const current = download && message.id === download.id;
    if (message.type === "updateProgress") {
      if (!current) return;
      if (message.installing) download.phase = "installing";
      if (Number.isFinite(message.received)) download.received = message.received;
      if (Number.isFinite(message.percent)) download.percent = message.percent;
      return beat();
    }
    if (message.type === "updateCancelResult") return void (current && download.aborting && decided(download, message.outcome));
    state.pending.get(message.id)?.(message);
  }

  return {
    start() { if (enabled) schedule(t.first); },
    stop() { clearTimeout(state.timer); },
    checkNow: () => void check({ manual: true }),
    receive,
    cancel,
    get installing() { return state.installing; },
  };
}
