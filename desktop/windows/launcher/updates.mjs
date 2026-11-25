// 什么时候查更新、问不问、装不装（对应 mac 的 Updater.swift；查、下、验签、交给安装包在壳里，见 shell/src/update.rs）。
//
// 带更新源的构建（NAVI_WIN_UPDATES=1）起来 1 分钟后查一次，之后每 6 小时一次；托盘「检查更新…」随时查。
// 查到新版就问用户：「现在更新」「跳过这一版」「以后再说」（关掉对话框按最后一个算）（记在 settings.json 的 skippedVersion，自动检查不再问它，
// 手动检查照样摆出来）。点了「现在更新」窗口盖上下载进度，下完壳把安装包交给系统、自己退出，安装包装完重开 Navi。
// 换的只是壳：服务和 agent 不停，新壳起来后再按 handover.mjs 换到新运行时。
import { readSettings, writeSettings } from "./settings.mjs";

export const FIRST_CHECK_MS = 60_000;
export const INTERVAL_MS = 6 * 60 * 60_000;

export function createUpdates({ cfg, send, ui, enabled = process.env.NAVI_WIN_UPDATES === "1", timing = {} }) {
  const t = { first: FIRST_CHECK_MS, interval: INTERVAL_MS, ...timing };
  const state = { serial: 0, pending: new Map(), timer: null, busy: false, installing: null };

  function request(message) {
    const id = `u${++state.serial}`;
    send({ ...message, id });
    return new Promise((resolve) => state.pending.set(id, resolve));
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
    if (state.busy || state.installing) return;
    state.busy = true;
    try {
      const found = await request({ type: "updateCheck" });
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
      if (choice === 1) writeSettings(cfg, { skippedVersion: found.version });
      if (choice === 0) await install(found.version);
    } finally {
      state.busy = false;
    }
  }

  async function install(version) {
    state.installing = version;
    ui.progress(version, null);
    const result = await request({ type: "updateInstall", version });
    // 装成了走不到这里：壳把安装包交出去就退出了。回来的只有失败。
    state.installing = null;
    ui.done();
    ui.log(`更新到 ${version} 没装上：${result.error}`);
    await ui.alert("更新没装上", `${result.error ?? "原因不明"}\n\n现在的版本照常能用，可以稍后从托盘菜单「检查更新…」再试。`);
  }

  function receive(message) {
    if (message.type === "updateProgress") {
      if (state.installing) ui.progress(state.installing, Number(message.percent));
      return;
    }
    const resolve = state.pending.get(message.id);
    state.pending.delete(message.id);
    resolve?.(message);
  }

  return {
    start() { if (enabled) schedule(t.first); },
    stop() { clearTimeout(state.timer); },
    checkNow: () => void check({ manual: true }),
    receive,
    get installing() { return state.installing; },
  };
}
