// 运行日志回归：npm -w server run test:runtime-log
//
// 钉住四件事：
//   1. 脱敏是白名单 —— 报错原文只换成固定说法（不按形状删字），路由记注册时的模板，页面报上来的
//      栈帧要核对成 navi 自己的代码文件；业务报错原文、文件路径、任务号、页面多塞的字段一个都进不了日志；
//   2. 落盘尽力而为且限流；
//   3. 卡顿检测 + 采样器在真实卡顿里采得到调用栈（JS 忙算、同步子进程两种都要采到 —— 后者正是
//      「服务卡住、窗口闪一下」最常见的样子，采不到这个功能就没有意义）；
//   4. 分析把每一次撤页归到对的原因上；上一轮服务怎么没的按身份（runId）对，只靠时间对的明说是推测；
//      任何一种「闪一下」的观察（壳撤页、页面崩溃、浏览器刷新、服务重启）单独出现都要列出来。
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
  assert.equal(engine.msg, "Cannot read properties of undefined/null", "引擎报错换成固定说法");
  assert.ok(!JSON.stringify(engine).includes("secretField"));

  // 引擎原生的 JSON 报错会把输入原样嵌进去，嵌套引号能骗过「抹掉引号里的」那种按形状删字。
  for (const input of ['{"x":secret-project}', '"客户秘密" trailing', "客户收购预算 500 万元"]) {
    let error: unknown;
    try { JSON.parse(input); } catch (caught) { error = caught; }
    const parsed = describeError(error);
    assert.equal(parsed.msg, "JSON parse error");
    assert.ok(!/secret|客户/.test(JSON.stringify(parsed)), `JSON 报错里的输入不能进日志：${JSON.stringify(parsed)}`);
  }
  assert.equal(describeError(new TypeError("客户收购预算 500 万元")).msg, undefined, "认不出是哪一类的 TypeError 不留原文");
  assert.equal(describeError(Object.assign(new Error("x"), { name: "CustomerAcquisitionError" })).name, "OtherError", "错误名只认名单");
  assert.equal(describeError(Object.assign(new Error("x"), { code: "customer-42" })).code, undefined, "错误码只认常量形状");

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

  const isCodeFile = (rel: string) => rel === "assets/a.js";
  const web = shared.sanitizeWebEvent({
    ev: "page.error", kind: "error", name: "Error", msg: "保存「客户名单」失败", title: "机密", shell: "mac", tab: "abc123", ago: 1500,
    frames: ["f assets/a.js:1", "customerSecret assets/customerSecret.js:1", "acquisition <native>", "<img src=x> evil"],
  }, isCodeFile);
  assert.deepEqual(web, {
    ev: "page.error", tab: "abc123", shell: "mac", ago: 1500, kind: "error", name: "Error",
    frames: ["f assets/a.js:1", "<anon> <other>", "<anon> <native>"],
  }, "认不出的代码文件连函数名一起抹掉");
  assert.equal(shared.sanitizeWebEvent({ ev: "page.crash", name: "TypeError", msg: "客户收购预算 500 万元" })!.msg, undefined, "页面报的 msg 必须正好是固定说法里的一句");
  assert.equal(shared.sanitizeWebEvent({ ev: "page.crash", name: "TypeError", msg: "Cannot read properties of undefined/null" })!.msg, "Cannot read properties of undefined/null");
  assert.equal(shared.sanitizeWebEvent({ ev: "task.content", text: "x" }), null, "名单外的事件不收");
  assert.deepEqual(shared.sanitizeWebEvent({ ev: "page.boot", nav: "reload", sincePrevMs: 1200.4, hidden: false, extra: "x" }), { ev: "page.boot", nav: "reload", hidden: false, sincePrevMs: 1200 });
}

// ── 1b. 慢请求和卡顿时在处理的请求记注册的路由模板，不是请求路径 ─────────
{
  const { Hono } = await import("hono");
  const { runtimeLogHttp, inflightSnapshot } = await import("../src/runtime-log/http.js");
  const app = new Hono();
  app.use("/api/*", runtimeLogHttp());
  const api = new Hono();
  let snapshot: ReturnType<typeof inflightSnapshot> = [];
  api.get("/tasks/:id/page/:token/:section/:what", async (c) => {
    snapshot = inflightSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 3100));
    return c.json({ ok: true });
  });
  app.route("/api", api);
  const response = await app.request("/api/tasks/abc123/page/token123/customer/acquisition?q=secret");
  assert.equal(response.status, 200);
  assert.deepEqual(snapshot.map((entry) => entry.route), ["/api/tasks/:id/page/:token/:section/:what"]);
  const slow = serverLines().filter((line) => line.ev === "http.slow");
  assert.equal(slow.length, 1);
  assert.equal(slow[0]!.route, "/api/tasks/:id/page/:token/:section/:what");
  assert.ok(!/abc123|token123|customer|acquisition|secret/.test(JSON.stringify(slow)), "请求路径里的任务号、片段、查询串都不进日志");
  assert.equal(shared.routePattern("/api/tasks/<script>"), "?");
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
    M(363_200, "server.spawn", { serverPid: 555 }),
    S(363_500, "server.refused", { holderPid: 100, pid: 555 }),
    S(365_000, "loop.stall", { n: 4, ms: 7000, from: at(358_000), cpuMs: 300, gcMs: 0, rssMB: 500, heapMB: 300, inflight: [{ method: "POST", route: "/api/tasks/:x/messages", ageMs: 7000 }] }),
    S(365_100, "loop.stall.stack", { n: 4, ms: 7000, samples: 690, stacks: [{ pct: 92, frames: ["execFileSync node:child_process", "regressionSnapshot server/dist/regression-snapshot.js:14"] }] }),
    M(366_000, "page.reload", { reason: "user" }),
    // 正常重启：SIGTERM 之后起来新的一份
    S(1_200_000, "server.start", { inst: "bbbb", run: "run-b", startupMs: 2400 }),
    M(1_201_000, "page.reload", { reason: "instance_changed", serverPid: 101 }),
    // 被强杀：残留锁、没有退出记录
    S(2_400_000, "server.start", { inst: "cccc", run: "run-c", previous: { run: "run-b", evidence: "none", silentMs: 4000 } }),
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
    { at: at(2_400_010), pid: 102, runId: "run-b", kind: "residual" as const, evidence: "none" as const, silentMs: 4000 },
  ];
  const report = analyzeRuntimeLog(records, exits);
  const causes = report.incidents.map((incident) => incident.cause);
  assert.deepEqual(causes, ["stall", "restart", "restart", "sleep", "webcontent", "unknown"], JSON.stringify(report.incidents.map((i) => i.summary)));
  const [stall, graceful, killed] = report.incidents;
  assert.match(stall!.summary, /卡住 7\.0 秒/);
  assert.ok(stall!.evidence.includes("窗口撤下页面：连续 3 次探活没等到答复"), JSON.stringify(stall!.evidence));
  assert.ok(stall!.evidence.some((line) => line.includes("窗口以为服务没了又起了一份（进程 555），被单例锁挡回")), JSON.stringify(stall!.evidence));
  assert.ok(stall!.evidence.some((line) => line.includes("在等")), "CPU 远小于卡顿时长 → 在等");
  assert.ok(stall!.evidence.some((line) => line.includes("regressionSnapshot")));
  assert.ok(stall!.evidence.some((line) => line.includes("POST /api/tasks/:x/messages")));
  assert.ok(graceful!.evidence.some((line) => line.includes("SIGTERM") && !line.includes("推测")), "按 runId 对上的不写推测");
  assert.ok(killed!.evidence.some((line) => line.includes("没留下任何退出记录")));
  assert.equal(report.restarts.length, 2, "第一条 server.start 不算重启");
  assert.equal(report.hotspots[0]?.frame, "regressionSnapshot server/dist/regression-snapshot.js:14");
  assert.equal(report.stalls.waiting, 1);
  const text = renderRuntimeLogReport(report, { timeline: true });
  assert.match(text, /窗口闪一下 \/ 重载：6 次/);
  assert.match(text, /卡顿时最常在跑的代码/);
}

// ── 4b. 按身份认上一轮；单独的观察也成一次 ──────────────────────────────
{
  const T = Date.parse("2026-11-26T01:00:00.000Z");
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  const S = (s: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(s), src: "server" as const, pid: 1, ev, ...fields });
  const W = (s: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(s), src: "web" as const, pid: 1, ev, ...fields });

  // A 正常停（SIGTERM）→ B 起来 → B 没留下任何记录就没了 → C 起来。C 不能被说成「有人让它停的」。
  const exits = [
    { at: at(99), pid: 100, runId: "a", kind: "signal" as const, signal: "SIGTERM", uptimeMs: 99_000 },
    { at: at(200), pid: 200, runId: "b", kind: "residual" as const, evidence: "none" as const, silentMs: 5000 },
  ];
  for (const previous of [{ run: "b", evidence: "none", silentMs: 5000 }, undefined]) {
    const report = analyzeRuntimeLog([
      S(0, "server.start", { run: "a", pid: 100 }),
      S(100, "server.start", { run: "b", pid: 200 }),
      S(200, "server.start", { run: "c", pid: 300, ...(previous ? { previous } : {}) }),
    ], exits);
    assert.deepEqual(report.restarts.map((r) => r.at), [at(100), at(200)], "全新启动（A）不算重启");
    assert.match(report.restarts[0]!.how, /SIGTERM/);
    assert.ok(!report.restarts[1]!.how.includes("SIGTERM"), `B 的异常消失不能借 A 的 SIGTERM：${report.restarts[1]!.how}`);
    assert.match(report.restarts[1]!.how, /没留下任何退出记录/);
    assert.equal(report.incidents.length, 2);
    assert.ok(report.incidents.every((incident) => incident.cause === "restart"));
  }

  // 日志窗口里只有一次启动，上一轮不在这份日志里：退回按时间找，且写明推测。
  const guessed = analyzeRuntimeLog([S(100, "server.start", { run: "new", pid: 200 })], [{ at: at(99), pid: 100, kind: "signal", signal: "SIGTERM" }]);
  assert.equal(guessed.incidents.length, 1, "窗口里第一条启动也可能是重启");
  assert.match(guessed.restarts[0]!.how, /^（按时间推测）.*SIGTERM/);
  assert.ok(guessed.incidents[0]!.evidence[0]!.startsWith("（按时间推测）"));
  assert.equal(analyzeRuntimeLog([S(100, "server.start", { run: "new" })], []).incidents.length, 0, "找不到上一轮就是全新启动");

  // 页面崩到错误屏、浏览器整页刷新：没有壳的事件也各算一次。
  const crash = analyzeRuntimeLog([S(0, "server.start"), W(100, "page.crash", { name: "TypeError", msg: "Cannot read properties of undefined/null" })], []);
  assert.deepEqual(crash.incidents.map((i) => i.cause), ["page_error"]);
  assert.ok(crash.incidents[0]!.evidence.some((line) => line.includes("Cannot read properties of undefined/null")));
  const reload = analyzeRuntimeLog([S(0, "server.start"), W(100, "page.boot", { nav: "reload" })], []);
  assert.deepEqual(reload.incidents.map((i) => i.cause), ["reload"]);
  assert.match(reload.incidents[0]!.summary, /整页刷新/);
  const retried = analyzeRuntimeLog([W(100, "page.reload", { reason: "load-failure" }), W(101, "page.boot", { nav: "reload" })], []);
  assert.deepEqual(retried.incidents.map((i) => i.summary), ["页面整页重载：在加载失败提示上点了刷新"]);
  assert.equal(analyzeRuntimeLog([W(100, "page.boot", { nav: "navigate" })], []).incidents.length, 0, "正常打开页面不算");
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
