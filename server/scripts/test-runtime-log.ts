// 运行日志回归：npm -w server run test:runtime-log
//
// 钉住四件事：
//   1. 脱敏是白名单 —— 业务报错原文、文件路径、任务号、页面多塞的字段一个都进不了日志；
//   2. 落盘尽力而为且限流；
//   3. 卡顿检测 + 采样器在真实卡顿里采得到调用栈（JS 忙算、同步子进程两种都要采到 —— 后者正是
//      「服务卡住、窗口闪一下」最常见的样子，采不到这个功能就没有意义）；
//   4. 分析把每一次撤页归到对的原因上。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "navi-runtime-log-"));
process.env.NAVI_DATA_DIR = root;
process.env.NAVI_DB = join(root, "navi.db");

const shared = await import("@navi/shared/runtime-log");
const { runtimeLog, runtimeLogDir } = await import("../src/runtime-log/journal.js");
const { describeError } = await import("../src/runtime-log/process-events.js");
const { analyzeRuntimeLog } = await import("../src/runtime-log/analyze.js");
const { renderRuntimeLogReport } = await import("../src/runtime-log/render.js");
const { readRuntimeLogDir, loadDataDir, buildRuntimeLogBundle } = await import("../src/runtime-log/load.js");
const { recordExit } = await import("../src/exit-ledger.js");
const { CODE_DIR } = await import("../src/paths.js");

function serverLines(): Array<Record<string, unknown>> {
  return readFileSync(join(runtimeLogDir(), "server.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ── 1. 脱敏 ──────────────────────────────────────────────────────────────
{
  const business = describeError(new Error("任务「发布季度财报」的 worktree 不存在"));
  assert.equal(business.name, "Error");
  assert.equal(business.msg, undefined, "业务报错的原文不能进日志");

  const engine = describeError(new TypeError(`Cannot read properties of undefined (reading 'secretField')`));
  assert.equal(engine.msg, "Cannot read properties of undefined (reading '…')", "引擎报错只留骨架，引号里的抹掉");

  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/acme/plan.md'"), { code: "ENOENT", syscall: "open" });
  const described = describeError(fsError);
  assert.equal(described.code, "ENOENT");
  assert.equal(described.syscall, "open");
  assert.equal(described.msg, undefined);
  assert.ok(!JSON.stringify(described).includes("acme"), "系统调用报错里的路径不能进日志");

  const frames = shared.scrubStack([
    "Error: boom",
    `    at continueTask (file://${CODE_DIR}/server/dist/orchestrator.js:120:7)`,
    "    at Object.<anonymous> (/Users/someone/acme/build.js:3:1)",
    `    at run (${CODE_DIR}/node_modules/hono/dist/index.js:9:9)`,
    "    at spawnSync (node:child_process:900:3)",
  ].join("\n"), [CODE_DIR]);
  assert.deepEqual(frames, [
    "continueTask server/dist/orchestrator.js:120",
    "Object.<anonymous> <other>",
    "run node_modules/hono",
    "spawnSync node:child_process",
  ]);
  assert.deepEqual(shared.scrubStack("f@http://localhost:4317/assets/index-abc.js:1:900", ["http://localhost:4317"]), ["f assets/index-abc.js:1"]);

  assert.equal(shared.routeTemplate("/api/tasks/6Of1arIEla8D/files/secret-plan.md?path=/Users/x"), "/api/tasks/:x/files/:x");

  const web = shared.sanitizeWebEvent({ ev: "page.error", kind: "error", name: "Error", msg: "保存「客户名单」失败", title: "机密", frames: ["f assets/a.js:1", "<img src=x> evil"], shell: "mac", tab: "abc123" });
  assert.deepEqual(web, { ev: "page.error", tab: "abc123", shell: "mac", kind: "error", name: "Error", frames: ["f assets/a.js:1"] });
  assert.equal(shared.sanitizeWebEvent({ ev: "task.content", text: "x" }), null, "名单外的事件不收");
  assert.deepEqual(shared.sanitizeWebEvent({ ev: "page.boot", nav: "reload", sincePrevMs: 1200.4, hidden: false, extra: "x" }), { ev: "page.boot", nav: "reload", hidden: false, sincePrevMs: 1200 });
}

// ── 2. 落盘与限流 ────────────────────────────────────────────────────────
{
  for (let i = 0; i < 40; i += 1) runtimeLog("test.flood", { i });
  const flood = serverLines().filter((line) => line.ev === "test.flood");
  assert.equal(flood.length, 30, "同一个事件每分钟最多 30 条");
  assert.equal(flood[0]!.src, "server");
  assert.equal(flood[0]!.pid, process.pid);
}

// ── 3. 真实卡顿里采到调用栈 ──────────────────────────────────────────────
{
  const { startRuntimeWatch } = await import("../src/runtime-log/watch.js");
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function spinTheLoopForRuntimeLogTest(ms: number) {
    const until = performance.now() + ms;
    let x = 0;
    while (performance.now() < until) x += Math.sqrt(x + 1);
    return x;
  }
  function waitOnChildForRuntimeLogTest() {
    execFileSync("sleep", ["1.8"]);
  }
  startRuntimeWatch();
  await pause(600);
  spinTheLoopForRuntimeLogTest(1800); // 第一次：武装采样器，本身采不到
  await pause(1200);
  spinTheLoopForRuntimeLogTest(1800);
  await pause(1200);
  waitOnChildForRuntimeLogTest();
  await pause(1500);

  const lines = serverLines();
  const stalls = lines.filter((line) => line.ev === "loop.stall");
  assert.ok(stalls.length >= 3, `三次卡顿都要记下（实际 ${stalls.length}）`);
  const [armed, spun, waited] = stalls.slice(-3) as Array<Record<string, number>>;
  assert.ok(armed!.ms >= 1500 && spun!.ms >= 1500 && waited!.ms >= 1500);
  assert.ok(spun!.cpuMs >= spun!.ms * 0.6, "忙算的那次 CPU 时间跟卡顿时长相当");
  assert.ok(waited!.cpuMs < waited!.ms * 0.3, "等子进程的那次几乎不占 CPU");

  const stacks = lines.filter((line) => line.ev === "loop.stall.stack") as Array<{ n: number; stacks: Array<{ pct: number; frames: string[] }> }>;
  assert.ok(!stacks.some((stack) => stack.n === armed!.n), "武装之前那次没有栈");
  const spunStack = stacks.find((stack) => stack.n === spun!.n);
  assert.ok(spunStack, "武装之后的卡顿要有栈");
  assert.ok(spunStack.stacks[0]!.frames.some((frame) => frame.startsWith("spinTheLoopForRuntimeLogTest server/scripts/test-runtime-log.ts:")),
    `忙算卡顿的栈要指到那个函数：${JSON.stringify(spunStack.stacks[0])}`);
  const waitedStack = stacks.find((stack) => stack.n === waited!.n);
  assert.ok(waitedStack, "卡在同步子进程里也要采到栈");
  assert.ok(waitedStack.stacks[0]!.frames.some((frame) => frame.startsWith("waitOnChildForRuntimeLogTest server/scripts/test-runtime-log.ts:")),
    `同步子进程卡顿的栈要指到调用它的函数：${JSON.stringify(waitedStack.stacks[0])}`);
  assert.ok(!JSON.stringify(stacks).includes(root), "栈里不带数据目录");
}

// ── 4. 分析 ──────────────────────────────────────────────────────────────
{
  const T = Date.parse("2026-11-20T10:00:00.000Z");
  const at = (ms: number) => new Date(T + ms).toISOString();
  const S = (ms: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(ms), src: "server" as const, pid: 100, ev, ...fields });
  const M = (ms: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(ms), src: "mac" as const, pid: 9, ev, ...fields });
  const records = [
    S(0, "server.start", { inst: "aaaa", run: "run-a" }),
    // 卡顿：06:00 起卡 7 秒，窗口在第 5 秒撤页、又起了一份服务被挡回
    M(360_002, "probe.miss", { probe: "unreachable", code: -1001, streak: 1 }),
    M(361_502, "probe.miss", { probe: "unreachable", code: -1001, streak: 2 }),
    M(363_002, "page.takedown", { probe: "unreachable", via: "guard", streak: 3 }),
    S(363_500, "server.refused", { holderPid: 100 }),
    S(365_000, "loop.stall", { n: 4, ms: 7000, from: at(358_000), cpuMs: 300, gcMs: 0, rssMB: 500, heapMB: 300, inflight: [{ method: "POST", route: "/api/tasks/:x/messages", ageMs: 7000 }] }),
    S(365_100, "loop.stall.stack", { n: 4, ms: 7000, samples: 690, stacks: [{ pct: 92, frames: ["execFileSync node:child_process", "regressionSnapshot server/dist/regression-snapshot.js:14"] }] }),
    M(366_000, "page.reload", { reason: "user" }),
    // 正常重启：SIGTERM 之后起来新的一份
    S(1_200_000, "server.start", { inst: "bbbb", run: "run-b", startupMs: 2400 }),
    M(1_201_000, "page.reload", { reason: "instance_changed", serverPid: 101 }),
    // 被强杀：残留锁、没有退出记录
    S(2_400_000, "server.start", { inst: "cccc", run: "run-c" }),
    M(2_401_000, "page.reload", { reason: "instance_changed", serverPid: 102 }),
    // 睡眠唤醒
    S(3_600_000, "system.sleep", { ms: 1_800_000 }),
    M(3_600_400, "page.takedown", { probe: "down", via: "guard" }),
    // 网页进程被结束
    M(4_800_000, "webcontent.terminated"),
    // 服务端什么都没有
    M(6_000_000, "page.takedown", { probe: "unreachable", via: "guard", streak: 3 }),
    S(6_100_000, "server.vitals", { rssMB: 400 }),
  ];
  const exits = [
    { at: at(1_195_000), pid: 100, runId: "run-a", kind: "signal" as const, signal: "SIGTERM", uptimeMs: 1_195_000 },
    { at: at(2_400_010), pid: 102, kind: "residual" as const, evidence: "none" as const, silentMs: 4000 },
  ];
  const report = analyzeRuntimeLog(records, exits);
  const causes = report.incidents.map((incident) => incident.cause);
  assert.deepEqual(causes, ["stall", "restart", "restart", "sleep", "webcontent", "unknown"], JSON.stringify(report.incidents.map((i) => i.summary)));
  const [stall, graceful, killed] = report.incidents;
  assert.match(stall!.summary, /卡住 7\.0 秒/);
  assert.ok(stall!.evidence.includes("窗口撤下页面：连续 3 次探活没等到答复"), JSON.stringify(stall!.evidence));
  assert.ok(stall!.evidence.some((line) => line.includes("被单例锁挡回")));
  assert.ok(stall!.evidence.some((line) => line.includes("在等")), "CPU 远小于卡顿时长 → 在等");
  assert.ok(stall!.evidence.some((line) => line.includes("regressionSnapshot")));
  assert.ok(stall!.evidence.some((line) => line.includes("POST /api/tasks/:x/messages")));
  assert.ok(graceful!.evidence.some((line) => line.includes("SIGTERM")));
  assert.ok(killed!.evidence.some((line) => line.includes("没留下任何退出记录")));
  assert.equal(report.restarts.length, 2, "第一条 server.start 不算重启");
  assert.equal(report.hotspots[0]?.frame, "regressionSnapshot server/dist/regression-snapshot.js:14");
  assert.equal(report.stalls.waiting, 1);
  const text = renderRuntimeLogReport(report, { timeline: true });
  assert.match(text, /窗口闪一下 \/ 重载：6 次/);
  assert.match(text, /卡顿时最常在跑的代码/);
}

// ── 5. 读目录、导出包 ────────────────────────────────────────────────────
{
  recordExit({ at: new Date().toISOString(), pid: 1, runId: "r1", kind: "signal", signal: "SIGTERM", note: "ps: /usr/bin/secret --token=abc" });
  const loaded = loadDataDir(root);
  assert.ok(loaded.records.some((record) => record.ev === "loop.stall"));
  assert.equal(loaded.exits.at(-1)?.signal, "SIGTERM");
  const bundle = buildRuntimeLogBundle(null);
  assert.equal(bundle.format, "navi-runtime-log");
  assert.ok(!JSON.stringify(bundle).includes("--token=abc"), "退出账本的 note（可能带别的进程的命令行）不进导出包");
  assert.ok(!JSON.stringify(bundle).includes(root), "导出包里不带本机路径");
  assert.equal(readRuntimeLogDir(runtimeLogDir()).length, loaded.records.length);
}

rmSync(root, { recursive: true, force: true });
console.log("[runtime-log] ok");
process.exit(0);
