// 桌面版换运行时的两块地基，mac 与 Windows 两套清单格式都过一遍：
//   · 跑着的代码是不是仓库里一份完整的受管运行时（runtimeCompatibilityAt）—— Windows 包是 format 2、仓库在
//     %LOCALAPPDATA%\Navi\runtimes、路径不分大小写；mac 包是 format 1、仓库在数据根下，原样不变；
//   · Windows 桌面版申请接管时带 holdResources：服务退出会收掉、又接不过去的东西（终端、项目服务……）还在，
//     就不发许可、许可当场撤掉，旧服务原样留着（acquireRuntimeHandover 的 standing）；
//   · 兑现许可（commitRuntimeHandover）：核验和下线是同一步，兑现后不再到期、撤不回，随即自己退出。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedRuntimeStore, runtimeCompatibilityAt } from "../src/runtime-compatibility.js";
import { acquireRuntimeHandover } from "../src/runtime-handover.js";
import { commitRuntimeHandover, reserveRuntimeHandover, runtimeHandoverActive } from "../src/runtime-handover-state.js";
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

  const realNow = Date.now;
  const later = (ms: number) => { const base = realNow(); Date.now = () => base + ms; };
  try {
    const expiring = reserveRuntimeHandover()!;
    later(61_000);
    assert.equal(commitRuntimeHandover(expiring, () => assert.fail("过期的许可不能兑现")), false, "到期了就兑现不了");
    assert.equal(runtimeHandoverActive(), false);
    Date.now = realNow;

    const lease = reserveRuntimeHandover()!;
    assert.equal(commitRuntimeHandover("not-the-lease", () => assert.fail()), false, "别人的许可兑现不了");
    let exited = 0;
    assert.equal(commitRuntimeHandover(lease, () => { exited++; }, 40), true);
    assert.equal(commitRuntimeHandover(lease, () => { exited++; }, 40), true, "重复兑现不另起退出");
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
