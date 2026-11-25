// 换运行时里「得有人接着把新版起起来」这份责任（handover.mjs 用）。
//
// 兑现许可（旧服务收到就自己下线）和强制切换的停服务都撤不回，所以**发出去之前**先记下这份责任，而不是看答复再记：
// 答复丢了、超时了，不等于对方没执行。之后不管收到成功、失败还是什么也没收到，只有亲眼看到结果才算结清：
//   · 端口上答话的是另一份服务（新版起来了，或者别人起了一份）；
//   · 或者还是交出去的那一份，但已经过了宽限期（兑现后 300 毫秒就退；过了几秒还在答话，说明它没下线、照常在接活）。
// 明确知道没执行（服务端答「兑现不了」、停之前就发现端口上换了人）才当场撤掉。窗口那边退出时（controller.shutdown）
// 还欠着就去起新版；起不来就记进数据根旁边的一张纸条，下一次打开 Navi 时说给用户听。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const GRACE_MS = 5_000;

export function createDuty({ grace = GRACE_MS } = {}) {
  let owed = null;
  return {
    /** 撤不回的那一步之前调：from 是交出去的那一份服务的实例号。 */
    owe(instance) { owed = { from: instance.id, since: Date.now() }; },
    /** 明确知道那一步没执行。 */
    clear() { owed = null; },
    /** 看到端口上有一份自己的服务在答话：够得上上面两条就结清。返回还欠不欠着。 */
    settle(instance) {
      if (owed && instance && (instance.id !== owed.from || Date.now() - owed.since >= grace)) owed = null;
      return Boolean(owed);
    },
    get pending() { return Boolean(owed); },
  };
}

const notePath = (cfg) => join(dirname(cfg.settingsFile), "handover-unfinished.json");

/** 退出前没能把新版起起来：留张纸条。 */
export function noteUnfinished(cfg, why) {
  mkdirSync(dirname(notePath(cfg)), { recursive: true });
  writeFileSync(notePath(cfg), JSON.stringify({ at: new Date().toISOString(), why }));
}

/** 取走上次留的纸条（没有就是 null）。 */
export function takeUnfinished(cfg) {
  let note = null;
  try { note = JSON.parse(readFileSync(notePath(cfg), "utf8")); } catch { return null; }
  rmSync(notePath(cfg), { force: true });
  return note && typeof note.why === "string" ? note : { why: "原因没记下来" };
}
