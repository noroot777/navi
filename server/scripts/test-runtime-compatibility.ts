// 桌面版换运行时的两块地基，mac 与 Windows 两套清单格式都过一遍：
//   · 跑着的代码是不是仓库里一份完整的受管运行时（runtimeCompatibilityAt）—— Windows 包是 format 2、仓库在
//     %LOCALAPPDATA%\Navi\runtimes、路径不分大小写；mac 包是 format 1、仓库在数据根下，原样不变；
//   · Windows 桌面版申请接管时带 holdResources：服务退出会收掉、又接不过去的东西（终端、项目服务……）还在，
//     就不发许可、许可当场撤掉，旧服务原样留着（acquireRuntimeHandover 的 standing）；
//   · 强制切换（acquireForcedRuntimeHandover）：同样先封口，封口之后的名单里多出用户没确认过的就不发许可、当场解封；
//   · 兑现许可（commitRuntimeHandover）：核验和下线是同一步，兑现后不再到期、撤不回，随即自己退出。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedRuntimeStore, runtimeCompatibilityAt } from "../src/runtime-compatibility.js";
import { acquireForcedRuntimeHandover, acquireRuntimeHandover } from "../src/runtime-handover.js";
import { commitRuntimeHandover, reserveRuntimeHandover, runtimeHandoverActive, runtimeHandoverDeadline } from "../src/runtime-handover-state.js";
import { heldTurns } from "../src/turn-lock.js";
import type { RestartImpact } from "../src/reattach.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const root = mkdtempSync(join(tmpdir(), "navi-runtime-compat-"));

/** 在 store 下摆一份运行时：.handover.json 进清单，目录名就是清单 id。返回它的目录。 */
function runtime(store: string, format: 1 | 2, { schema = "a".repeat(64), tamper = false } = {}) {
  const stage = join(store, `.stage-${format}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(stage, "server"), { recursive: true });
  const handover = JSON.stringify({ protocol: 1, schema });
  writeFileSync(join(stage, ".handover.json"), handover);
  const entry = format === 1 ? [".handover.json", "file", 0, sha(handover)] : [".handover.json", "file", sha(handover)];
  const entries = [entry, ["server", "directory"], ...(tamper ? [["tampered", "directory"]] : [])];
  if (tamper) mkdirSync(join(stage, "tampered"));
  const id = sha(JSON.stringify(entries));
  writeFileSync(join(stage, ".runtime.json"), JSON.stringify(format === 1 ? { format, id, entries } : { format, platform: "win32", id, entries }));
  if (tamper) writeFileSync(join(stage, ".handover.json"), JSON.stringify({ protocol: 1, schema: "b".repeat(64) }));
  const target = join(store, id);
  renameSync(stage, target);
  return target;
}

try {
  assert.equal(managedRuntimeStore("darwin", {}, "/data"), "/data/.mac-runtimes");
  assert.equal(managedRuntimeStore("win32", { LOCALAPPDATA: "/Users/x/AppData/Local" }, "/data"), join("/Users/x/AppData/Local", "Navi", "runtimes"));
  assert.equal(managedRuntimeStore("win32", {}, "/data"), null, "LOCALAPPDATA 缺了就不认任何受管运行时");
  assert.equal(managedRuntimeStore("linux", {}, "/data"), null);
  console.log("✓ 运行时仓库：mac 在数据根下，Windows 在 LOCALAPPDATA\\Navi\\runtimes，别的系统没有");

  const macStore = join(root, "data", ".mac-runtimes");
  mkdirSync(macStore, { recursive: true });
  const mac = runtime(macStore, 1);
  assert.deepEqual(runtimeCompatibilityAt(mac, macStore, "darwin"), { protocol: 1, schema: "a".repeat(64) });
  assert.throws(() => runtimeCompatibilityAt(mac, macStore, "win32"), /版本身份不符/, "mac 包不能当 Windows 包认");
  assert.throws(() => runtimeCompatibilityAt(runtime(macStore, 1, { tamper: true }), macStore, "darwin"), /协议身份不符/);
  console.log("✓ mac（format 1）照旧：清单、目录名、封进清单的接管协议都要对上");

  const winStore = join(root, "local", "Navi", "runtimes");
  mkdirSync(winStore, { recursive: true });
  const win = runtime(winStore, 2);
  assert.deepEqual(runtimeCompatibilityAt(win, winStore, "win32"), { protocol: 1, schema: "a".repeat(64) });
  assert.equal(runtimeCompatibilityAt(win, winStore.replace(/Navi/, "NAVI"), "win32").protocol, 1,
    "Windows 上仓库路径换个大小写写法也是同一处");
  assert.throws(() => runtimeCompatibilityAt(win, macStore, "win32"), /不是本数据根的受管运行时/, "别的仓库里的不认");
  assert.throws(() => runtimeCompatibilityAt(win, null, "win32"), /不是本数据根的受管运行时/);
  assert.throws(() => runtimeCompatibilityAt(win, winStore, "darwin"), /版本身份不符/, "Windows 包不能当 mac 包认");
  assert.throws(() => runtimeCompatibilityAt(runtime(winStore, 2, { tamper: true }), winStore, "win32"), /协议身份不符/);
  const loose = join(root, "loose");
  mkdirSync(loose);
  assert.throws(() => runtimeCompatibilityAt(loose, winStore, "win32"), /不是本数据根的受管运行时/, "仓库外的目录不认");
  console.log("✓ Windows（format 2）：清单带 platform、不记可执行位，仓库外、改过协议、换了格式的一律不认");

  const empty: RestartImpact = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };
  let asked = 0;
  const held = await acquireRuntimeHandover(async () => empty, heldTurns, undefined, async () => {
    asked++;
    assert.equal(runtimeHandoverActive(), true, "封口之后才问还在跑的终端和项目服务");
    return ["终端 · 长跑命令"];
  });
  assert.equal(asked, 1);
  assert.equal(held.lease, undefined);
  assert.match(held.error ?? "", /仍在使用：终端 · 长跑命令/);
  assert.deepEqual(held.standing, ["终端 · 长跑命令"]);
  assert.equal(runtimeHandoverActive(), false, "不发许可时当场撤掉，旧服务继续接活");
  const clear = await acquireRuntimeHandover(async () => empty, heldTurns, undefined, async () => []);
  assert.ok(clear.lease, "终端都关了才发许可");
  const { releaseRuntimeHandover } = await import("../src/runtime-handover-state.js");
  releaseRuntimeHandover(clear.lease!);
  const mac2 = await acquireRuntimeHandover(async () => empty, heldTurns);
  assert.ok(mac2.lease, "不传 standing（mac）时不问这一项");
  releaseRuntimeHandover(mac2.lease!);
  console.log("✓ holdResources：终端、项目服务还在就不切，问的是封口之后的最后一份，许可随即撤掉；mac 不传就不问");

  const blocking = (...ids: string[]): RestartImpact => ({ ...empty, runtimeHandover: { sessions: [],
    blocked: ids.map((id) => ({ id, title: `任务 ${id}`, reason: "调度台当前回合不能无损接管" })) } });
  const seal = async () => { assert.equal(runtimeHandoverActive(), true, "先封口"); };
  const checkpointed: string[][] = [];
  const prep = { seal, checkpoint: async (sessions: string[]) => {
    assert.equal(runtimeHandoverActive(), true, "封口之后才到检查点");
    checkpointed.push(sessions);
  } };
  const grown = await acquireForcedRuntimeHandover(async () => blocking("t9"), new Set(["t9"]), prep, async () => {
    assert.equal(runtimeHandoverActive(), true, "封口之后才看会打断的终端");
    return [{ id: "terminal:s2", title: "终端「cargo watch」" }];
  });
  assert.equal(grown.lease, undefined, "确认之后新开的终端：不发许可");
  assert.deepEqual(grown.widened, [{ id: "terminal:s2", title: "终端「cargo watch」" }], "把多出来的交回去重新问");
  assert.equal(runtimeHandoverActive(), false, "当场解封，旧服务照常接活");
  const task = await acquireForcedRuntimeHandover(async () => blocking("t9", "t10"), new Set(["t9"]), prep, async () => []);
  assert.deepEqual(task.widened?.map((item) => item.id), ["t10"], "多出没确认过的任务也一样");
  const agreed = await acquireForcedRuntimeHandover(async () => blocking("t9"), new Set(["t9", "terminal:s1"]), prep,
    async () => [{ id: "terminal:s1", title: "终端「PowerShell」" }]);
  assert.ok(agreed.lease, "都在确认过的里面（变少也算）：发许可");
  assert.equal(runtimeHandoverActive(), true, "发了许可就一直封着，直到兑现后旧服务退出");
  releaseRuntimeHandover(agreed.lease!);
  const unknown = await acquireForcedRuntimeHandover(async () => empty, new Set(), prep, async () => []);
  assert.match(unknown.error ?? "", /确认不了/, "旧服务报不出会打断谁：不发");
  assert.equal(runtimeHandoverActive(), false);
  await assert.rejects(acquireForcedRuntimeHandover(async () => blocking(), new Set(), { ...prep, seal: async () => { throw new Error("仍有请求在执行"); } }, async () => []), /仍有请求/);
  assert.equal(runtimeHandoverActive(), false, "封不住口：许可撤掉");
  console.log("✓ 强制切换：封口之后核对用户确认过的名单，多出一项就不发许可、当场解封；发了许可就一直封着");

  // 没在名单上的、能接管的会话：用户只确认了关掉终端，另一条任务还在输出 —— 它照样先到检查点（正文、水位落盘）再发许可。
  const withSession = (sessions: string[], ...ids: string[]): RestartImpact => ({ ...blocking(...ids),
    runtimeHandover: { ...blocking(...ids).runtimeHandover!, sessions } });
  checkpointed.length = 0;
  const kept = await acquireForcedRuntimeHandover(async () => withSession(["sess-a"]), new Set(["terminal:s1"]), prep,
    async () => [{ id: "terminal:s1", title: "终端「PowerShell」" }]);
  assert.ok(kept.lease, "只打断确认过的终端：发许可");
  assert.deepEqual(checkpointed, [["sess-a"]], "没确认打断的会话先到检查点，才发许可");
  releaseRuntimeHandover(kept.lease!);
  await assert.rejects(acquireForcedRuntimeHandover(async () => withSession(["sess-a"]), new Set(), { ...prep,
    checkpoint: async () => { throw new Error("输出消费屏障未就绪"); } }, async () => []), /屏障未就绪/);
  assert.equal(runtimeHandoverActive(), false, "到不了检查点：不发许可、当场解封");
  let round = 0;
  const lost = await acquireForcedRuntimeHandover(async () => (round++ ? withSession([], "t11") : withSession(["sess-a"])),
    new Set(), prep, async () => []);
  assert.deepEqual(lost.widened?.map((item) => item.id), ["t11"], "检查点之后那条会话接不过去了：没确认过，交回去重新问");
  assert.equal(runtimeHandoverActive(), false);
  round = 0;
  const grew = await acquireForcedRuntimeHandover(async () => withSession(round++ ? ["sess-a", "sess-b"] : ["sess-a"]),
    new Set(), prep, async () => []);
  assert.match(grew.error ?? "", /状态变化/, "检查点之后多出一条没到检查点的会话：不发");
  assert.equal(runtimeHandoverActive(), false);
  console.log("✓ 强制切换只打断确认过的：别的能接管的会话照样先到检查点，之后再核一遍，变了就不发");

  const realNow = Date.now;
  const later = (ms: number) => { const base = realNow(); Date.now = () => base + ms; };
  try {
    const expiring = reserveRuntimeHandover()!;
    const fence = runtimeHandoverDeadline(expiring)!;
    later(fence - Date.now() + 1);
    assert.equal(commitRuntimeHandover(expiring, () => assert.fail("过期的许可不能兑现")), false, "到期了就兑现不了");
    assert.equal(runtimeHandoverActive(), false);
    Date.now = realNow;

    const lease = reserveRuntimeHandover()!;
    const deadline = runtimeHandoverDeadline(lease)!;
    assert.ok(deadline > Date.now() && deadline <= Date.now() + 60_000, "许可带着最晚兑现时刻（接管方据此断定晚到的兑现不会再执行）");
    assert.equal(runtimeHandoverDeadline("not-the-lease"), null);
    assert.equal(commitRuntimeHandover("not-the-lease", () => assert.fail()), false, "别人的许可兑现不了");
    let exited = 0;
    assert.equal(commitRuntimeHandover(lease, () => { exited++; }, 40), true);
    assert.equal(commitRuntimeHandover(lease, () => { exited++; }, 40), true, "重复兑现不另起退出");
    assert.equal(runtimeHandoverDeadline(lease), Infinity, "兑现后不再有到期时刻");
    later(10 * 60_000);
    assert.equal(runtimeHandoverActive(), true, "兑现后不再到期：封口保持到退出");
    Date.now = realNow;
    assert.equal(releaseRuntimeHandover(lease), false, "兑现了就撤不回：不会解封接新活、再被人照旧答复停掉");
    assert.equal(runtimeHandoverActive(), true);
    assert.equal(exited, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(exited, 1, "兑现了就自己退出，只退一次");
    const { COMMITTED_EXIT_MS } = await import("../src/runtime-handover-state.js");
    assert.ok(COMMITTED_EXIT_MS <= 1_000, "只留够送出答复的那一下，不留「封着等人来停」的空当");
  } finally {
    Date.now = realNow;
  }
  console.log("✓ 兑现许可：到期或别人的兑现不了；兑现了不再到期、撤不回，随即自己退出");
} finally {
  rmSync(root, { recursive: true, force: true });
}
