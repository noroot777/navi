// 什么时候查更新、问不问、装不装（对应 mac 的 Updater.swift；查、下、验签、交给安装包在壳里，见 shell/src/update.rs）。
//
// 带更新源的构建（NAVI_WIN_UPDATES=1）起来 1 分钟后查一次，之后每 6 小时一次；托盘「检查更新…」随时查。
// 查到新版就问用户：「现在更新」「跳过这一版」「以后再说」（关掉对话框按最后一个算）（记在 settings.json 的 skippedVersion，自动检查不再问它，
// 手动检查照样摆出来）。点了「现在更新」窗口盖上下载进度，下完壳把安装包交给系统、自己退出，安装包装完重开 Navi。
// 换的只是壳：服务和 agent 不停，新壳起来后再按 handover.mjs 换到新运行时。
//
// 每一步都有头（壳里查 30 秒、下 15 分钟、300 MB，见 update.rs）；这里再兜一层：壳那边过了头还没回话
// （或者下载一分多钟没有一点进展）就当没成，叫壳收掉那一趟（updateCancel），放开状态、页面回来。
// 下载那一屏有「取消」，点了就是这一条路。正在切换到新版服务时不下更新，在下更新时也不切（handover.mjs 问 busy）：
// 两边都要占着窗口那一屏，谁也不能半路把对方的页面换掉。
import { readSettings, writeSettings } from "./settings.mjs";

export const FIRST_CHECK_MS = 60_000;
export const INTERVAL_MS = 6 * 60 * 60_000;
export const CHECK_LIMIT_MS = 60_000;
export const INSTALL_LIMIT_MS = 16 * 60_000;
export const STALL_LIMIT_MS = 90_000;

export function createUpdates({ cfg, send, ui, enabled = process.env.NAVI_WIN_UPDATES === "1", busy = () => null, timing = {} }) {
  const t = { first: FIRST_CHECK_MS, interval: INTERVAL_MS, check: CHECK_LIMIT_MS, install: INSTALL_LIMIT_MS, stall: STALL_LIMIT_MS, ...timing };
  const state = { serial: 0, pending: new Map(), timer: null, busy: false, installing: null, download: null };

  /** 发给壳、等它回话；limitMs 到了还没回就按 { error, timedOut } 收场。返回 { id, done, settle }。 */
  function request(message, limitMs) {
    const id = `u${++state.serial}`;
    let settle;
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => settle({ error: "等了太久没有回音", timedOut: true }), limitMs);
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
    const download = request({ type: "updateInstall", version }, t.install);
    state.download = { ...download, stall: null, cancelled: false };
    progress(null);
    const result = await download.done;
    // 装成了走不到这里：壳把安装包交出去就退出了。回来的只有失败、超时和取消。
    clearTimeout(state.download.stall);
    const { cancelled } = state.download;
    state.download = null;
    state.installing = null;
    if (result.timedOut || cancelled) send({ type: "updateCancel" });
    ui.done();
    if (cancelled) return ui.log(`取消了更新到 ${version}`);
    ui.log(`更新到 ${version} 没装上：${result.error}`);
    await ui.alert("更新没装上", `${result.error || "原因不明"}\n\n现在的版本照常能用，可以稍后从托盘菜单「检查更新…」再试。`);
  }

  /** 盖上进度那一屏、重新计「没进展」的时。 */
  function progress(percent) {
    const download = state.download;
    ui.progress(state.installing, percent, cancel);
    clearTimeout(download.stall);
    download.stall = setTimeout(() => download.settle({ error: `下载 ${Math.round(t.stall / 1000)} 秒没有进展`, timedOut: true }), t.stall);
  }

  function cancel() {
    if (!state.download) return;
    state.download.cancelled = true;
    state.download.settle({ error: "已取消" });
  }

  function receive(message) {
    if (message.type === "updateProgress") {
      if (state.download && message.id === state.download.id) progress(Number(message.percent));
      return;
    }
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
