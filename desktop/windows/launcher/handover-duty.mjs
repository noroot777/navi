// 换运行时里「得有人接着把新版起起来」这份责任（handover.mjs 用）。
//
// 兑现许可（旧服务收到就自己下线）和强制切换的停服务都撤不回，所以**发出去之前**先记下这份责任，而不是看答复再记：
// 答复丢了、超时了，不等于对方没执行。结清只认两种答案，都不靠这边计时去猜「它大概不会再动了」：
//   · 端口上答话的是另一份服务（新版起来了，或者别人起了一份）；
//   · 交出去的那一份自己说没兑现（handover.mjs 的 ask）：兑现是幂等的，许可一旦到期或归还就再也兑现不了，
//     所以它说「没兑现」就是终局 —— 在途、晚到的那次兑现也不会再执行。强制切换没有许可可问，停的结果不明就一直欠着。
// 窗口那边退出时（controller.shutdown）还欠着就去起新版；起不来就记进数据根旁边的一张纸条，下一次打开 Navi 时说给用户听。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function createDuty() {
  let owed = null;
  return {
    /** 撤不回的那一步之前调：from 是交出去的那一份服务的实例号；走许可时带上许可和它的最晚兑现时刻（fence）。 */
    owe(instance, lease = null) { owed = { from: instance.id, ...(lease ?? {}) }; },
    /** 明确知道那一步没执行、也不会再执行。 */
    clear() { owed = null; },
    /** 端口上答话的是另一份服务：结清。还是交出去的那一份不算，要去问它。返回还欠不欠着。 */
    settle(instance) {
      if (owed && instance && instance.id !== owed.from) owed = null;
      return Boolean(owed);
    },
    get owed() { return owed; },
    get pending() { return Boolean(owed); },
  };
}

const notePath = (cfg) => join(dirname(cfg.settingsFile), "handover-unfinished.json");

/** 退出前没能把新版起起来：留张纸条。 */
export function noteUnfinished(cfg, why) {
  mkdirSync(dirname(notePath(cfg)), { recursive: true });
  writeFileSync(notePath(cfg), JSON.stringify({ at: new Date().toISOString(), why }));
}

/** 读上次留的纸条（没有就是 null），不删：说给用户听过了再 forgetUnfinished。 */
export function readUnfinished(cfg) {
  let note = null;
  try { note = JSON.parse(readFileSync(notePath(cfg), "utf8")); } catch { return null; }
  return note && typeof note.why === "string" ? note : { why: "原因没记下来" };
}

/** 纸条说过了：删掉。删不掉返回原因（下次打开会再说一遍），不抛。 */
export function forgetUnfinished(cfg) {
  try { rmSync(notePath(cfg), { force: true }); return null; }
  catch (error) { return error.message; }
}
