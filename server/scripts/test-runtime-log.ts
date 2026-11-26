// 运行日志回归：npm -w server run test:runtime-log
//
// 钉住四件事：
//   1. 脱敏是白名单 —— 报错原文只换成固定说法（不按形状删字），路由记注册时的模板，栈帧只留核对成 navi 自己
//      代码文件的位置（不存函数名）；业务报错原文、文件路径、任务号、页面多塞的字段一个都进不了日志；页面上
//      整页崩溃不被普通报错的额度吞掉；
//   2. 落盘尽力而为且限流，目录被清掉了会重建；页面分批发、状态排前，服务端超额先收状态、截掉的留个数；
//      读回来的每一条（含更早版本写下的）都按当前规则重新投影，报告和导出只见投影之后的；
//   3. 卡顿检测 + 采样器在真实卡顿里采得到调用栈（JS 忙算、同步子进程两种都要采到 —— 后者正是
//      「服务卡住、窗口闪一下」最常见的样子，采不到这个功能就没有意义）；
//   4. 分析把每一次撤页归到对的原因上；上一轮服务是谁按身份（runId）对，怎么没的只说记录里有的；每次「闪一下」
//      只由看见它的那一方（窗口 / 页面）来数，两边的次数分开报、不相加，别的来源只附「按时间对上」。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { readRuntimeLogDir, loadDataDir, buildRuntimeLogBundle, loadRuntimeLogPath } = await import("../src/runtime-log/load.js");
const { recordExit } = await import("../src/exit-ledger.js");
const { CODE_DIR } = await import("../src/paths.js");

function serverLines(): Array<Record<string, unknown>> {
  return readFileSync(join(runtimeLogDir(), "server.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ── 1. 脱敏 ──────────────────────────────────────────────────────────────
{
  const { serverCodeLocations, webCodeLocations, digestPageId } = await import("../src/runtime-log/code-symbols.js");
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

  // 错误码、系统调用名只认名单：长得像常量（ERR_ 前缀、小写下划线）不算数。
  const coded = (code: unknown, syscall?: string) => describeError(Object.assign(new Error("x"), { code, syscall }));
  assert.equal(coded("ERR_CUSTOMER_ACQUISITION").code, "OTHER");
  assert.equal(coded("ECUSTOMER").code, "OTHER");
  assert.equal(coded("customer-42").code, "OTHER");
  assert.equal(coded("SQLITE_CUSTOMER").code, "OTHER");
  assert.equal(coded("SQLITE_BUSY_SNAPSHOT").code, "SQLITE_BUSY", "SQLite 扩展码记主结果码");
  assert.equal(coded("ERR_STREAM_PREMATURE_CLOSE").code, "ERR_STREAM_PREMATURE_CLOSE");
  assert.equal(coded("EADDRINUSE", "customer_db").syscall, undefined);
  assert.equal(shared.scrubMethod("ACQUIRECUSTOMER"), "OTHER", "HTTP 方法是请求方写的，只认名单");
  assert.equal(shared.scrubMethod("PATCH"), "PATCH");

  const fsError = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/acme/plan.md'"), { code: "ENOENT", syscall: "open" });
  const described = describeError(fsError);
  assert.equal(described.code, "ENOENT");
  assert.equal(described.syscall, "open");
  assert.equal(described.msg, undefined);
  assert.ok(!JSON.stringify(described).includes("acme"), "系统调用报错里的路径不能进日志");

  // 栈帧：只留核对过的代码位置，函数名一个都不存（Node 内置模块的公开导出除外）。
  const journalLines = readFileSync(join(CODE_DIR, "server/src/runtime-log/journal.ts"), "utf8").split("\n");
  const insideRuntimeLog = journalLines.findIndex((line) => line.startsWith("export function runtimeLog(")) + 3;
  const candidates = shared.scrubStack([
    "Error: boom",
    `    at runtimeLog (file://${CODE_DIR}/server/src/runtime-log/journal.ts:${insideRuntimeLog}:7)`,
    `    at CustomerAcquisitionBudget (file://${CODE_DIR}/server/src/runtime-log/journal.ts:${insideRuntimeLog}:7)`,
    `    at OpenAI (file://${CODE_DIR}/server/src/runtime-log/journal.ts:1:1)`,
    `    at continueTask (${CODE_DIR}/server/src/no-such-file.js:120:7)`,
    "    at Object.<anonymous> (/Users/someone/acme/build.js:3:1)",
    `    at run (${CODE_DIR}/node_modules/hono/dist/index.js:9:9)`,
    "    at execFileSync (node:child_process:900:3)",
    "    at OpenAI (node:fs:12:3)",
    "    at spawnSync (node:internal/child_process:1100:20)",
  ].join("\n"), [CODE_DIR], 12);
  const at = `server/src/runtime-log/journal.ts:${insideRuntimeLog}`;
  assert.deepEqual(candidates.slice(0, 2), [`runtimeLog ${at}`, `CustomerAcquisitionBudget ${at}`]);
  const verified = shared.verifyFrames(candidates, serverCodeLocations, 12);
  assert.equal(verified[0], at, "navi 代码只留位置，对着代码看那一行就知道是哪个函数");
  assert.equal(verified[1], at, "上报的名字不管是什么都不留");
  assert.equal(verified[2], "server/src/runtime-log/journal.ts:1");
  assert.equal(verified[3], "<other>", "不存在的文件不当代码位置");
  assert.equal(verified[4], "<other>");
  assert.ok(["node_modules/hono", "<other>"].includes(verified[5]!), `依赖不给名字：${verified[5]}`);
  assert.equal(verified[6], "execFileSync node:child_process", "Node 内置模块的公开导出名");
  assert.equal(verified[7], "node:fs", "不是那个模块公开导出的名字：只留位置");
  assert.equal(verified[8], "node:internal");
  assert.ok(!/CustomerAcquisitionBudget|OpenAI/.test(JSON.stringify(verified)));
  assert.equal(serverCodeLocations.resolve("server/../../../etc/hosts"), null, "跳出代码目录的不认");
  assert.deepEqual(shared.verifyFrames(["(gc)", "(idle)", "(program)", "(evil)"], serverCodeLocations), ["(gc)", "(idle)", "(program)", "<other>"], "采样器的固定帧读回来还是它");
  assert.equal(shared.scrubErrorCode(shared.scrubErrorCode(5)), "5", "整数码过两遍还是它");
  assert.equal(shared.scrubErrorCode("12345678901234"), "OTHER");
  // 规范化之后存在的不算：被规范化掉的那一段可以是任何东西（第 2 轮复审实测客户名这样带进了导出）。
  const aliased = [
    `f server/src/CustomerBudgetSecret/../runtime-log/journal.ts:3`,
    "server/src/./runtime-log/journal.ts:3",
    "server/src//runtime-log/journal.ts:3",
    `${at}:0`,
    `${at}:123456789`,
  ];
  assert.deepEqual(shared.verifyFrames(aliased, serverCodeLocations), aliased.map(() => "<other>"), "只认规范写法、有效的行列号");
  assert.equal(shared.verifyFrames([`${at}:7`], serverCodeLocations)[0], `${at}:7`, "输出是核对结果重新拼的");
  assert.deepEqual(shared.verifyFrames(["f ", "", "nospace", "f :1", `${at}`], serverCodeLocations), ["<other>", "<other>", "<other>", "<other>", at],
    "形状不对的帧当成认不出的一帧，不抛");

  // 真抛一次：名字是运行时拼出来的（来自数据）也进不了日志；那一帧照样定位得到这个文件。
  // 这个名字在本文件里只能拼出来，不能整个写出来。
  const dataName = ["Quarterly", "Merger", "Plan"].join("");
  const dynamic = { [dataName]: () => { throw new TypeError("x is not a function"); } };
  function namedThrowerForRuntimeLogTest() { dynamic[dataName]!(); }
  let thrown: unknown;
  try { namedThrowerForRuntimeLogTest(); } catch (caught) { thrown = caught; }
  const real = describeError(thrown);
  assert.ok(!JSON.stringify(real).includes(dataName), `运行时拼出来的函数名不能进日志：${JSON.stringify(real.frames)}`);
  assert.ok(!JSON.stringify(real).includes("namedThrower"), "写在代码里的函数名也不存");
  assert.ok((real.frames as string[]).some((frame) => frame.startsWith("server/scripts/test-runtime-log.ts:")), JSON.stringify(real.frames));
  assert.deepEqual(shared.scrubStack("f@http://localhost:4317/assets/index-abc.js:1:900", ["http://localhost:4317"]), ["f assets/index-abc.js:1:900"],
    "页面产物带列号：压成一行的产物只有它能定位");

  // 页面报上来的：同一道核对，外加标识换成摘要。
  const locations = { resolve: (file: string) => (file === "assets/a.js" ? file : null), nameAt: () => null };
  const options = { locations, digest: digestPageId };
  const web = shared.sanitizeWebEvent({
    ev: "page.error", kind: "error", name: "Error", msg: "保存「客户名单」失败", title: "机密", shell: "mac", tab: "abc123", load: "Customer42", ago: 1500,
    frames: ["f assets/a.js:1:5", "OpenAI assets/a.js:1:9", "customerSecret assets/customerSecret.js:1", "acquisition <native>", "<img src=x> evil"],
  }, options);
  assert.deepEqual(web, {
    ev: "page.error", tab: digestPageId("abc123"), load: digestPageId("Customer42"), shell: "mac", ago: 1500, kind: "error", name: "Error",
    frames: ["assets/a.js:1:5", "assets/a.js:1:9", "<other>", "<native>", "<other>"],
  }, "页面报的函数名一个都不留：文件真在、词在产物里出现过都不算");
  assert.ok(!/abc123|Customer|OpenAI/.test(JSON.stringify(web)), "页面生成的标识只留摘要");
  assert.equal(webCodeLocations.resolve("src/lib/runtimeLog.ts"), "src/lib/runtimeLog.ts", "开发时的页面源码按磁盘上的文件核对");
  const smuggled = shared.sanitizeWebEvent({ ev: "page.error", kind: "error", name: "Error",
    frames: ["f src/CustomerAcquisitionBudget/../lib/runtimeLog.ts:1:1", "src/QuarterlyMergerPlan/../lib/runtimeLog.ts:2:3", "src/lib/runtimeLog.ts:2:3"] },
  { locations: webCodeLocations, digest: digestPageId });
  assert.deepEqual(smuggled!.frames, ["<other>", "<other>", "src/lib/runtimeLog.ts:2:3"], "带 .. 的位置原串不进日志");
  assert.equal(webCodeLocations.nameAt("src/lib/runtimeLog.ts", 1, "reportPageCrash"), null, "页面报的名字一个都不收");
  assert.equal(webCodeLocations.resolve("src/../../server/src/main.ts"), null);
  assert.equal(shared.sanitizeWebEvent({ ev: "page.crash", name: "TypeError", msg: "客户收购预算 500 万元" }, options)!.msg, undefined, "页面报的 msg 必须正好是固定说法里的一句");
  assert.equal(shared.sanitizeWebEvent({ ev: "page.crash", name: "TypeError", msg: "Cannot read properties of undefined/null" }, options)!.msg, "Cannot read properties of undefined/null");
  assert.equal(shared.sanitizeWebEvent({ ev: "task.content", text: "x" }, options), null, "名单外的事件不收");
  assert.deepEqual(shared.sanitizeWebEvent({ ev: "page.boot", nav: "reload", sincePrevMs: 1200.4, hidden: false, extra: "x", prev: "l0", shellPid: 4242 }, options),
    { ev: "page.boot", nav: "reload", hidden: false, sincePrevMs: 1200 }, "多塞的字段、不像标识的标识都不收");
}

// ── 1c. 页面采集：整页崩溃是状态变化，不占普通报错的额度，也不被批量上限挤掉 ─────
{
  const posted: Array<Record<string, unknown>> = [];
  const batches: string[][] = [];
  const listeners = new Map<string, (event: { error?: unknown; reason?: unknown }) => void>();
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    location: { origin: "http://localhost:4317" },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    document: { visibilityState: "visible" },
    window: { addEventListener: (name: string, fn: (event: { error?: unknown }) => void) => listeners.set(name, fn) },
    fetch: async (_url: string, init: { body: string }) => {
      const { events } = JSON.parse(init.body) as { events: Array<Record<string, unknown>> };
      posted.push(...events);
      batches.push(events.map((event) => String(event.ev)));
      return new Response("{}");
    },
  });
  const page = await import("../../web/src/lib/runtimeLog.ts");
  const fail = (i: number) => Object.assign(new Error("x"), { stack: `Error: x\n    at f${i} (http://localhost:4317/assets/a.js:${i}:1)` });
  for (let i = 1; i <= 12; i += 1) listeners.get("error")!({ error: fail(i) });
  // 第 4 轮复审实测：连接反复断开恢复攒出二十几条详情，排在后面的崩溃被服务端只收前 20 条截掉了。
  for (let i = 0; i < 11; i += 1) { page.reportEventsConnection(false); page.reportEventsConnection(true); }
  page.reportPageCrash(new TypeError("boom"));
  page.reportPageCrash(new TypeError("again"));
  assert.equal(posted.filter((event) => event.ev === "page.error").length, 10, "普通报错照旧只报前 10 条");
  assert.equal(posted.filter((event) => event.ev === "page.crash").length, 1, "普通报错用完了额度，整页崩溃也要记下（一次载入只记一次）");
  assert.ok(batches.every((batch) => batch.length <= shared.WEB_EVENTS_PER_POST), `每次发的不超过服务端一次收的：${batches.map((b) => b.length)}`);
  assert.deepEqual(batches[0]!.slice(0, 2), ["page.boot", "page.crash"], "状态排在最前");
  assert.equal(posted.length, 1 + 10 + 22 + 1 + 1, "分批发完，一条不少");
  assert.deepEqual(posted.filter((event) => event.ev === "page.skipped").map((event) => event.count), [2], "超过额度没报的报错留下个数");
  // 发出去没送到（服务不在 / 被拒）：下一批里说一声丢了几条。
  const realFetch = globalThis.fetch;
  Object.assign(globalThis, { fetch: async () => new Response("{}", { status: 401 }) });
  page.reportEventsConnection(false);
  page.reportPageReload("reclaim");
  await new Promise((resolve) => setTimeout(resolve, 10));
  Object.assign(globalThis, { fetch: realFetch });
  page.reportEventsConnection(true);
  page.reportPageReload("reclaim");
  assert.deepEqual(posted.filter((event) => event.ev === "page.skipped").at(-1), { ev: "page.skipped", count: 0, unsent: 2, tab: posted[0]!.tab, load: posted[0]!.load, shell: "browser", ago: 0 },
    JSON.stringify(posted.at(-1)));
  for (const name of ["location", "sessionStorage", "document", "window", "fetch"]) Reflect.deleteProperty(globalThis, name);

  // 服务端：老页面一批塞得比上限多时，先收状态、再收详情，没收的记个数。
  const { Hono } = await import("hono");
  const { mountRuntimeLogRoutes } = await import("../src/runtime-log/routes.js");
  const api = new Hono();
  mountRuntimeLogRoutes(api);
  const oversized = [...Array.from({ length: 24 }, () => ({ ev: "events.down", tab: "tabA", load: "loadA" })), { ev: "page.crash", name: "TypeError", tab: "tabA", load: "loadA" }];
  const response = await api.request("/runtime-log/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: oversized }) });
  assert.deepEqual(await response.json(), { kept: 20, dropped: 5 });
  const web = serverLines().filter((line) => line.src === "web");
  assert.equal(web.filter((line) => line.ev === "page.crash").length, 1, "排在第 25 条的崩溃照样收下");
  assert.deepEqual(web.filter((line) => line.ev === "log.dropped").map((line) => [line.of, line.count]), [["events.down", 5]], "截掉的留下个数");
  // 每一处不收都要留下记录：超过扫描上限没看的（第 5 轮复审实测第 201 条的崩溃无声无息）、认不出的、请求体读不出来的。
  const post = (body: string) => api.request("/runtime-log/events", { method: "POST", headers: { "content-type": "application/json" }, body });
  const beyondScan = [...Array.from({ length: 200 }, () => ({ ev: "events.down", tab: "tabB", load: "loadB" })), { ev: "page.crash", name: "TypeError", tab: "tabB", load: "loadB" }, { ev: "task.content" }];
  assert.deepEqual(await (await post(JSON.stringify({ events: beyondScan }))).json(), { kept: 20, dropped: 182 }, "个数按收到的全部算");
  assert.deepEqual(await (await post("{not json")).json(), { kept: 0, dropped: null });
  assert.deepEqual(await (await post(JSON.stringify({ events: [{ ev: "task.content", text: "客户" }] }))).json(), { kept: 0, dropped: 1 });
  const marks = serverLines().filter((line) => line.src === "web" && line.ev === "log.dropped").slice(1).map((line) => [line.of, line.count]);
  assert.deepEqual(marks, [["events.down", 180], ["batch.unexamined", 2], ["batch.unexamined", undefined], ["batch.unrecognized", 1]], JSON.stringify(marks));
  const lowerBound = analyzeRuntimeLog(serverLines() as never, []);
  assert.ok(lowerBound.notes.some((note) => note.includes("可能有载入 / 重载 / 崩溃") && note.includes("下限")), JSON.stringify(lowerBound.notes));
}

// ── 1b. 慢请求和卡顿时在处理的请求记注册的路由模板，不是请求路径 ─────────
{
  const { Hono } = await import("hono");
  const { runtimeLogHttp, requestsDuring } = await import("../src/runtime-log/http.js");
  const app = new Hono();
  app.use("/api/*", runtimeLogHttp());
  const api = new Hono();
  let snapshot: ReturnType<typeof requestsDuring> = [];
  api.get("/tasks/:id/page/:token/:section/:what", async (c) => {
    snapshot = requestsDuring(0, performance.now());
    await new Promise((resolve) => setTimeout(resolve, 3100));
    return c.json({ ok: true });
  });
  // 同步干完活就返回的请求：等定时器发现卡顿时它已经完成了，也得认得出是它。
  api.post("/tasks/:id/blocking", (c) => {
    const until = performance.now() + 60;
    while (performance.now() < until) { /* 同步阻塞 */ }
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
  const before = performance.now();
  await app.request("/api/tasks/abc123/blocking", { method: "POST" });
  const blocked = requestsDuring(before, performance.now());
  assert.deepEqual(blocked.map((entry) => [entry.method, entry.route, entry.done]), [["POST", "/api/tasks/:id/blocking", true]]);
  assert.ok(blocked[0]!.ageMs >= 50);
  assert.deepEqual(requestsDuring(performance.now() + 1, performance.now() + 2), [], "跟这段时间不重叠的不算");
  assert.equal(shared.routePattern("/api/tasks/<script>"), "?");
}

// ── 2. 落盘与限流 ────────────────────────────────────────────────────────
{
  for (let i = 0; i < 40; i += 1) runtimeLog("test.flood", { i });
  const flood = serverLines().filter((line) => line.ev === "test.flood");
  assert.deepEqual(serverLines().filter((line) => line.ev === "log.dropping" && line.src === "server").map((line) => line.of), ["test.flood"],
    "开始丢的那一刻就记下，不等下一条同类事件；一个窗口只记一次");
  assert.equal(flood.length, 30, "同一个事件每分钟最多 30 条");
  runtimeLog("test.huge", { pad: "x".repeat(9000) });
  assert.deepEqual(serverLines().filter((line) => line.of === "test.huge").map((line) => line.ev), ["log.too_long"], "超长写不下的也留下「丢了一条」");
  assert.equal(flood[0]!.src, "server");
  assert.equal(flood[0]!.pid, process.pid);
  // 运行中日志目录被清掉：下一条照样写得进去。
  rmSync(runtimeLogDir(), { recursive: true, force: true });
  runtimeLog("test.after_cleanup");
  assert.ok(serverLines().some((line) => line.ev === "test.after_cleanup"), "目录被删后要重建");
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
  // 名字由代码位置读出来（见第 1 节）。tsx 直接跑 TS 时采样器给的是转译后代码的行号，读不准名字，
  // 所以这里只认位置；生产跑的是 server/dist 的 JS，行号就是那份文件的。
  const inThisFile = (frame: string) => /(?:^| )server\/scripts\/test-runtime-log\.ts:\d+$/.test(frame);
  assert.ok(spunStack.stacks[0]!.frames.some(inThisFile), `忙算卡顿的栈要指到这份代码：${JSON.stringify(spunStack.stacks[0])}`);
  const waitedStack = stacks.find((stack) => stack.n === waited!.n);
  assert.ok(waitedStack, "卡在同步子进程里也要采到栈");
  assert.ok(waitedStack.stacks[0]!.frames.includes("execFileSync node:child_process") && waitedStack.stacks[0]!.frames.some(inThisFile),
    `同步子进程卡顿的栈要指到 execFileSync 和调用它的代码：${JSON.stringify(waitedStack.stacks[0])}`);
  assert.ok(!JSON.stringify(stacks).includes(root), "栈里不带数据目录");
}

// ── 4. 分析 ──────────────────────────────────────────────────────────────
{
  const T = Date.parse("2026-11-20T10:00:00.000Z");
  const at = (ms: number) => new Date(T + ms).toISOString();
  const S = (ms: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(ms), src: "server" as const, pid: 100, ev, ...fields });
  const M = (ms: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(ms), src: "mac" as const, pid: 9, ev, ...fields });
  // 窗口里的页面：每次载进来一页（load），带着上一页是哪个（prev）；壳记下它显示出来了（page.presented）。
  let page = 0;
  const boot = (ms: number, nav = "navigate") => [
    { at: at(ms), src: "web" as const, pid: 100, ev: "page.boot", shell: "mac", tab: "tab1", nav, prev: `p${page}`, load: `p${++page}` },
    M(ms + 100, "page.presented"),
  ];
  const records = [
    S(0, "server.start", { inst: "aaaa", run: "run-a" }),
    // 卡顿：06:00 起卡 7 秒，窗口在第 5 秒撤页、又起了一份服务被挡回
    M(360_002, "probe.miss", { probe: "unreachable", code: -1001, streak: 1 }),
    M(361_502, "probe.miss", { probe: "unreachable", code: -1001, streak: 2 }),
    M(363_002, "page.takedown", { probe: "unreachable", via: "guard", streak: 3 }),
    M(363_200, "server.spawn", { serverPid: 555 }),
    S(363_500, "server.refused", { holderPid: 100, pid: 555 }),
    S(365_000, "loop.stall", { n: 4, ms: 7000, from: at(358_000), cpuMs: 300, gcMs: 0, rssMB: 500, heapMB: 300, inflight: [{ method: "POST", route: "/api/tasks/:x/messages", ageMs: 7000 }] }),
    S(365_100, "loop.stall.stack", { n: 4, ms: 7000, samples: 690, stacks: [{ pct: 92, frames: ["execFileSync node:child_process", "server/dist/regression-snapshot.js:14"] }] }),
    M(366_000, "page.reload", { reason: "user" }),
    ...boot(367_000, "reload"),
    // 正常重启：SIGTERM 之后起来新的一份
    S(1_200_000, "server.start", { inst: "bbbb", run: "run-b", pid: 101, startupMs: 2400 }),
    M(1_201_000, "page.reload", { reason: "instance_changed", serverPid: 101 }),
    ...boot(1_202_000, "reload"),
    // 被强杀：残留锁、没有退出记录
    S(2_400_000, "server.start", { inst: "cccc", run: "run-c", pid: 102, previous: { run: "run-b", evidence: "none", silentMs: 4000 } }),
    M(2_401_000, "page.reload", { reason: "instance_changed", serverPid: 102 }),
    ...boot(2_402_000, "reload"),
    // 睡眠唤醒
    S(3_600_000, "system.sleep", { ms: 1_800_000 }),
    M(3_600_400, "page.takedown", { probe: "down", via: "guard" }),
    ...boot(3_603_000),
    // 网页进程被结束
    M(4_800_000, "webcontent.terminated"),
    ...boot(4_800_500, "reload"),
    // 服务端什么都没有
    M(6_000_000, "page.takedown", { probe: "unreachable", via: "guard", streak: 3 }),
    S(6_100_000, "server.vitals", { rssMB: 400 }),
  ];
  const exits = [
    { at: at(1_195_000), pid: 100, runId: "run-a", kind: "signal" as const, signal: "SIGTERM", uptimeMs: 1_195_000 },
    { at: at(2_400_010), pid: 101, runId: "run-b", kind: "residual" as const, evidence: "none" as const, silentMs: 4000 },
  ];
  const report = analyzeRuntimeLog(records, exits);
  const causes = report.incidents.map((incident) => incident.cause);
  assert.deepEqual(causes, ["stall", "restart", "restart", "sleep", "webcontent", "unknown"], JSON.stringify(report.incidents.map((i) => i.summary)));
  const [stall, graceful, killed] = report.incidents;
  assert.match(stall!.summary, /卡住了 7\.0 秒/);
  assert.ok(stall!.evidence.includes("窗口撤下页面：连续 3 次探活没等到答复"), JSON.stringify(stall!.evidence));
  assert.ok(stall!.evidence.some((line) => line.includes("窗口以为服务没了又起了一份（进程 555），被单例锁挡回")), JSON.stringify(stall!.evidence));
  assert.ok(stall!.evidence.some((line) => line.includes("在等")), "CPU 远小于卡顿时长 → 在等");
  assert.ok(stall!.evidence.some((line) => line.includes("server/dist/regression-snapshot.js:14")));
  assert.ok(stall!.evidence.some((line) => line.includes("POST /api/tasks/:x/messages")));
  assert.match(graceful!.summary, /实例号变了/, "窗口自己看见的服务换了一份");
  assert.ok(graceful!.evidence.some((line) => line.includes("SIGTERM") && !line.includes("推测")), "上一轮按 runId 对上的不写推测");
  assert.ok(graceful!.evidence.some((line) => line.startsWith("（按时间对上）")), "服务那一侧的重启只是时间上对得上");
  assert.ok(killed!.evidence.some((line) => line.includes("没留下任何退出记录")));
  assert.equal(report.restarts.length, 2, "查不到上一轮的那条 server.start 不算重启");
  assert.ok(report.incidents.every((incident) => incident.timeline.filter((r) => r.ev === "page.boot").length <= 1), "窗口每次载回来的那一页只归它前面那一次");
  assert.equal(report.hotspots[0]?.frame, "server/dist/regression-snapshot.js:14");
  assert.equal(report.stalls.waiting, 1);
  const text = renderRuntimeLogReport(report, { timeline: true });
  assert.match(text, /窗口闪一下 \/ 重载：窗口看到 6 次（/);
  assert.ok(!text.includes("页面看到"), "这几次都只有窗口看见");
  assert.match(text, /卡顿时最常在跑的代码/);
}

// ── 4b. 上一轮只说记录里有的；每次只由看见的那一方来数 ──────────────────
{
  const T = Date.parse("2026-11-26T01:00:00.000Z");
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  const S = (s: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(s), src: "server" as const, pid: 1, ev, ...fields });
  const W = (s: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(s), src: "web" as const, pid: 1, ev, ...fields });
  const M = (s: number, ev: string, fields: Record<string, unknown> = {}) => ({ at: at(s), src: "mac" as const, pid: 9, ev, ...fields });
  const sigterm = (s: number, runId?: string) => ({ at: at(s), pid: 100, kind: "signal" as const, signal: "SIGTERM", uptimeMs: 99_000, ...(runId ? { runId } : {}) });

  // A 正常停（SIGTERM）→ B 起来 → B 没留下任何记录就没了 → C 起来。C 不能借 A 的 SIGTERM。
  const exits = [sigterm(99, "a"), { at: at(200), pid: 200, runId: "b", kind: "residual" as const, evidence: "none" as const, silentMs: 5000 }];
  for (const previous of [{ run: "b", evidence: "none", silentMs: 5000 }, undefined]) {
    const report = analyzeRuntimeLog([
      S(0, "server.start", { run: "a", pid: 100 }),
      S(100, "server.start", { run: "b", pid: 200 }),
      S(200, "server.start", { run: "c", pid: 300, ...(previous ? { previous } : {}) }),
    ], exits);
    assert.deepEqual(report.restarts.map((r) => r.at), [at(100), at(200)], "查不到上一轮的 A 不算重启");
    assert.match(report.restarts[0]!.how, /SIGTERM/);
    assert.ok(!report.restarts[1]!.how.includes("SIGTERM"), `B 的异常消失不能借 A 的 SIGTERM：${report.restarts[1]!.how}`);
    assert.match(report.restarts[1]!.how, /没留下任何退出记录.*可能是/);
    assert.equal(report.incidents.length, 0, "服务重启没有窗口看见就不算一次闪，只进重启清单");
  }

  // 认得出是哪一轮、却没有它的任何退出证据：说不知道。
  const twoStarts = [S(0, "server.start", { run: "a", pid: 100 }), S(100, "server.start", { run: "b", pid: 200 })];
  const noEvidence = analyzeRuntimeLog(twoStarts, []).restarts[0]!.how;
  assert.match(noEvidence, /怎么停的不知道/);
  assert.ok(!/删掉了自己的锁|走过退出流程|有人让它停|放掉了/.test(noEvidence), noEvidence);
  // 同一轮既有退出意向又有残留：残留压过意向，只说记到了什么、可能是什么。
  const residualWithIntent = analyzeRuntimeLog(twoStarts, [sigterm(99, "a"), { at: at(100), pid: 100, runId: "a", kind: "residual", evidence: "exit_intent" }]).restarts[0]!.how;
  assert.match(residualWithIntent, /收到 SIGTERM（进程自己记的），但锁还留着（下一份服务启动时看到的）；可能是/);
  // 进程自己写下的退出记录只说明它走到了哪一步：收到 SIGTERM、放掉了锁之后照样可能被强杀，不说成「它退出了」。
  const stopped = analyzeRuntimeLog(twoStarts, [sigterm(99, "a")]).restarts[0]!.how;
  assert.match(stopped, /收到 SIGTERM（进程自己记的.*），下一份服务启动时没看到它留下的锁；之后进程最终怎么结束的没有进程外的记录/);
  assert.ok(!stopped.includes("放掉"), "退出记录写在释放锁之前，不说它放掉了锁");
  assert.ok(!/SIGTERM 退出|自己退出了|有人/.test(stopped), stopped);
  const exited = analyzeRuntimeLog(twoStarts, [{ at: at(99), pid: 100, runId: "a", kind: "exit", code: 0 }]).restarts[0]!.how;
  assert.match(exited, /走到了退出、退出码 0（进程自己记的），下一份服务启动时没看到它留下的锁/);

  // 上一轮不在这份日志里：退回按时间找，且写明推测；残留记录也算。
  const guessed = analyzeRuntimeLog([S(100, "server.start", { run: "new", pid: 200 })], [sigterm(99)]);
  assert.match(guessed.restarts[0]!.how, /^（按时间推测）.*SIGTERM/);
  const onlyResidual = analyzeRuntimeLog([S(100, "server.start", { run: "b", pid: 200 })], [{ at: at(100), pid: 100, runId: "a", kind: "residual", evidence: "none" }]);
  assert.match(onlyResidual.restarts[0]!.how, /^（按时间推测）上一份服务没留下任何退出记录/);
  assert.equal(analyzeRuntimeLog([S(100, "server.start", { run: "new" })], []).restarts.length, 0, "找不到上一轮的线索就不算重启");

  // 读取窗口之前那次启动是上下文：窗口里第一次重启靠它认上一轮，它自己不进结果。
  const windowed = analyzeRuntimeLog([S(-8 * 86_400, "server.start", { run: "old", pid: 100 }), S(100, "server.start", { run: "new", pid: 200 })], [], T);
  assert.deepEqual(windowed.restarts.map((r) => r.at), [at(100)], "窗口外那次启动不报，但这次重启认得出上一轮");
  assert.equal(windowed.counts.server, 1, "统计只算窗口里的");

  // 页面崩到错误屏、浏览器整页刷新：页面自己看见的，各算一次。
  const crash = analyzeRuntimeLog([S(0, "server.start"), W(100, "page.crash", { name: "TypeError", msg: "Cannot read properties of undefined/null" })], []);
  assert.deepEqual(crash.incidents.map((i) => i.cause), ["page_error"]);
  assert.ok(crash.incidents[0]!.evidence.some((line) => line.includes("Cannot read properties of undefined/null")));
  const reload = analyzeRuntimeLog([S(0, "server.start"), W(100, "page.boot", { nav: "reload" })], []);
  assert.deepEqual(reload.incidents.map((i) => i.cause), ["reload"]);
  assert.match(reload.incidents[0]!.summary, /整页刷新/);
  assert.equal(analyzeRuntimeLog([W(100, "page.boot", { nav: "navigate" })], []).incidents.length, 0, "正常打开页面不算");
  // 浏览器刷新附近有一次服务重启：只附在证据里、标明按时间对上，原因还是刷新。
  const refreshedNearRestart = analyzeRuntimeLog([...twoStarts, W(103, "page.boot", { nav: "reload", tab: "t", load: "l2", prev: "l1" })], [sigterm(99, "a")]);
  assert.deepEqual(refreshedNearRestart.incidents.map((i) => i.cause), ["reload"]);
  assert.ok(refreshedNearRestart.incidents[0]!.evidence[0]!.startsWith("（按时间对上）这之前 3.0 秒，服务重启了一次"), JSON.stringify(refreshedNearRestart.incidents[0]!.evidence));

  // 同一次载入的「主动重载」和接着载进来的那一页（prev 指着它）是同一次。
  const retried = analyzeRuntimeLog([
    W(100, "page.reload", { reason: "load-failure", tab: "t1", load: "l1" }),
    W(101, "page.boot", { nav: "reload", tab: "t1", load: "l2", prev: "l1" }),
  ], []);
  assert.deepEqual(retried.incidents.map((i) => i.summary), ["页面整页重载：在加载失败提示上点了刷新"]);

  // 到达顺序不改变次数：页面事件的时间是服务端收到时倒推的，旧页的重载 / 崩溃可能排在新页的载入之后。
  // 刷新进来那一页之后自己再崩，是新的一次。
  const lateReload = analyzeRuntimeLog([
    W(100, "page.boot", { nav: "reload", tab: "t1", load: "l2", prev: "l1" }),
    W(101, "page.reload", { reason: "error-screen", tab: "t1", load: "l1" }),
    W(200, "page.boot", { nav: "reload", tab: "t2", load: "m2", prev: "m1" }),
    W(201, "page.crash", { name: "TypeError", tab: "t2", load: "m1" }),
    W(300, "page.crash", { name: "TypeError", tab: "t2", load: "m2" }),
  ], []);
  assert.deepEqual(lateReload.incidents.map((i) => i.summary), ["页面整页重载：在错误屏上点了重新载入", "页面脚本出错，整页换成了错误屏", "页面脚本出错，整页换成了错误屏"],
    JSON.stringify(lateReload.incidents.map((i) => i.summary)));
  // 服务端自己的记录被限流过：次数只是下限。
  const serverThrottled = analyzeRuntimeLog([S(100, "loop.stall", { n: 1, ms: 2000, from: at(98) }), S(110, "log.dropping", { of: "loop.stall" })], []);
  assert.ok(serverThrottled.notes.some((note) => note.includes("服务端") && note.includes("loop.stall") && note.includes("下限")), JSON.stringify(serverThrottled.notes));

  // 同一个标签页隔几秒刷新三次、两个标签页各出一次事——每一次都要在。
  const thrice = analyzeRuntimeLog([1, 2, 3].map((n) => W(100 + n * 4, "page.boot", { nav: "reload", tab: "t1", load: `l${n}`, prev: `l${n - 1}` })), []);
  assert.equal(thrice.incidents.length, 3, "不同的载入从不合并");
  const legacy = analyzeRuntimeLog([100, 110, 120].map((s) => W(s, "page.boot", { nav: "reload", tab: "t1" })), []);
  assert.equal(legacy.incidents.length, 3, "没有载入标识的老记录也不按时间并");
  const tabs = analyzeRuntimeLog([
    W(100, "page.crash", { tab: "ta", load: "la", name: "TypeError" }),
    W(110, "page.boot", { tab: "tb", load: "lb2", prev: "lb1", nav: "reload" }),
  ], []);
  assert.deepEqual(tabs.incidents.map((i) => i.cause), ["page_error", "reload"], "两个标签页的事各是各的");
  assert.ok(tabs.incidents[1]!.timeline.every((r) => r.tab !== "ta"), "别的标签页的事不进这一次的时间线");

  // 页面里一块的兜底接住了报错（整页还在）不算一次；之后被刷新时，它是那次刷新的线索。
  const boundary = W(100, "page.error", { kind: "boundary", name: "ChunkLoadError", tab: "t1", load: "l1" });
  assert.equal(analyzeRuntimeLog([boundary], []).incidents.length, 0);
  const refreshedAfter = analyzeRuntimeLog([boundary, W(130, "page.boot", { nav: "reload", tab: "t1", load: "l2", prev: "l1" })], []);
  assert.equal(refreshedAfter.incidents[0]!.cause, "page_error");
  assert.ok(refreshedAfter.incidents[0]!.evidence.some((line) => line.startsWith("页面里一块的兜底接住了报错 ChunkLoadError")), JSON.stringify(refreshedAfter.incidents[0]));
  assert.equal(analyzeRuntimeLog([boundary, W(130, "page.boot", { nav: "reload", tab: "t1", load: "l9", prev: "l8" })], []).incidents[0]!.cause, "reload",
    "别的载入里的报错不拿来解释这一次");

  // 桌面壳里的页面由壳来数：壳里载回来的那一页（哪怕是 reload 进来的）不另算；同一时刻浏览器标签页里的崩溃是另一次。
  const shellAndTab = analyzeRuntimeLog([
    M(100, "page.takedown", { probe: "unreachable", streak: 3 }),
    W(105, "page.crash", { tab: "tb", load: "lb", name: "TypeError", shell: "browser" }),
    M(108, "page.takedown", { probe: "down", via: "navigation" }),
    W(120, "page.boot", { tab: "tm", load: "m2", prev: "m1", nav: "reload", shell: "mac" }),
    M(121, "page.presented"),
  ], []);
  assert.deepEqual(shellAndTab.incidents.map((i) => i.cause), ["unknown", "page_error"], JSON.stringify(shellAndTab.incidents.map((i) => i.summary)));

  // 两份壳各出一次事、关掉重开再出事——按壳进程分开，各自显示出来了才收口。
  const independentShells = analyzeRuntimeLog([
    M(100, "page.takedown", { pid: 10, probe: "down", via: "guard" }),
    M(105, "webcontent.terminated", { pid: 20 }),
    M(110, "page.presented", { pid: 10 }),
    M(112, "page.presented", { pid: 20 }),
  ], []);
  assert.deepEqual(independentShells.incidents.map((i) => i.cause), ["refused_connection", "webcontent"], JSON.stringify(independentShells.incidents.map((i) => i.summary)));
  const relaunched = analyzeRuntimeLog([
    M(100, "page.reload", { pid: 10, reason: "user" }),
    M(101, "app.quit", { pid: 10 }),
    M(120, "app.launch", { pid: 20 }),
    M(125, "webcontent.terminated", { pid: 20 }),
  ], []);
  assert.deepEqual(relaunched.incidents.map((i) => i.cause), ["reload", "webcontent"], "关掉重开之后的是新的一次");
  const presented = analyzeRuntimeLog([
    M(100, "page.takedown", { probe: "unreachable", streak: 3 }),
    M(110, "page.presented"),
    M(200, "page.takedown", { probe: "down" }),
  ], []);
  assert.equal(presented.incidents.length, 2, "显示出来之后再撤页是新的一次");
  // 撤页之后在离线提示上点了重新载入：原因是撤页，不是那一下点击。
  const takedownThenUser = analyzeRuntimeLog([M(100, "page.takedown", { probe: "down" }), M(130, "page.reload", { reason: "user" })], []);
  assert.deepEqual(takedownThenUser.incidents.map((i) => i.cause), ["refused_connection"]);

  // 用户已经看见的失败都要成一次：没载出来、载进来了没显示出来。
  const loadFailed = analyzeRuntimeLog([M(100, "page.load_failed", { domain: "NSURLErrorDomain", code: -1004 })], []);
  assert.deepEqual(loadFailed.incidents.map((i) => i.cause), ["load_failed"]);
  assert.ok(loadFailed.incidents[0]!.evidence.some((line) => line.includes("NSURLErrorDomain -1004")));
  const notPresented = analyzeRuntimeLog([M(100, "page.not_presented", { why: "timeout" })], []);
  assert.deepEqual(notPresented.incidents.map((i) => i.cause), ["not_presented"]);
  const loadFailedInStall = analyzeRuntimeLog([
    S(104, "loop.stall", { n: 1, ms: 6000, from: at(98), cpuMs: 100 }),
    M(100, "page.load_failed", { domain: "NSURLErrorDomain", code: -1001 }),
  ], []);
  assert.deepEqual(loadFailedInStall.incidents.map((i) => i.cause), ["stall"], "没载出来也拿服务那一侧解释");
  assert.ok(loadFailedInStall.incidents[0]!.evidence.some((line) => line.startsWith("（按时间对上）服务主线程卡了")), JSON.stringify(loadFailedInStall.incidents[0]!.evidence));

  // 同一次故障窗口和页面可能都记了：各数各的，次数分开报、不相加。
  const bothSaw = analyzeRuntimeLog([
    M(100, "page.takedown", { probe: "down" }),
    W(104, "page.crash", { tab: "t", load: "l1", name: "TypeError", shell: "mac" }),
  ], []);
  assert.deepEqual(bothSaw.incidents.map((i) => i.seenBy), ["window", "page"]);
  assert.deepEqual(bothSaw.causes, { window: { refused_connection: 1 }, page: { page_error: 1 } });
  assert.equal(shared.observedCounts(bothSaw), "窗口看到 1 次（连接被拒 1）；页面看到 1 次（页面脚本出错 1）");
  assert.ok(!/2 次/.test(renderRuntimeLogReport(bothSaw)), "不把两边的次数加成一个总数");
  // 页面那边的状态变化被限流挡掉过：明说次数只是下限。只有开始丢的那一条（风暴之后再没有同类事件）也要说。
  const throttled = analyzeRuntimeLog([W(100, "page.boot", { nav: "reload", tab: "t", load: "l2" }), W(160, "log.dropped", { of: "page.boot", count: 4 })], []);
  assert.ok(throttled.notes.some((note) => note.includes("至少 4 条") && note.includes("下限")), JSON.stringify(throttled.notes));
  const startedDropping = analyzeRuntimeLog([W(100, "page.boot", { nav: "reload", tab: "t", load: "l2" }), W(101, "log.dropping", { of: "page.reload" })], []);
  assert.ok(startedDropping.notes.some((note) => note.includes("下限")), JSON.stringify(startedDropping.notes));
  // 起不来的那次进报错汇总，带着卡在哪一步。
  const startupFailed = analyzeRuntimeLog([S(100, "server.startup_failed", { stage: "server listen failed", name: "Error", code: "EADDRINUSE" })], []);
  assert.equal(startupFailed.errors[0]?.name, "启动失败（server listen failed） Error(EADDRINUSE)");
  // 整页崩溃的那一条排在证据最前，前面的普通报错是上下文。
  const crashAfterErrors = analyzeRuntimeLog([
    ...[1, 2, 3].map((n) => W(100 + n, "page.error", { kind: "error", name: "RangeError", tab: "t", load: "lc" })),
    W(110, "page.crash", { kind: "error", name: "TypeError", tab: "t", load: "lc" }),
  ], []);
  assert.ok(crashAfterErrors.incidents[0]!.evidence[0]!.startsWith("页面报错 TypeError"), JSON.stringify(crashAfterErrors.incidents[0]!.evidence));

  // 壳发现实例号变了：重启是壳自己看见的；服务那一侧的启动记录离得远（进程号复用、日志对不上）就不附。
  const reused = analyzeRuntimeLog([
    S(0, "server.start", { run: "a", pid: 100 }),
    S(100, "server.start", { run: "b", pid: 101 }),
    M(100 + 7200, "page.reload", { reason: "instance_changed", serverPid: 101 }),
  ], [sigterm(99, "a")]);
  assert.deepEqual(reused.incidents.map((i) => i.cause), ["restart"], JSON.stringify(reused.incidents.map((i) => i.summary)));
  assert.ok(!reused.incidents[0]!.evidence.some((line) => line.includes("SIGTERM")), "两小时前的那次重启不附在这一次上");
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

  // 读回来的每一条都按当前规则重新投影：更早版本写下的原文、请求路径、多余字段、认不出的事件都不出去。
  const legacy = [
    { at: new Date().toISOString(), src: "server", pid: 7, ev: "server.error", kind: "uncaught", name: "CustomerAcquisitionBudget",
      msg: "CustomerAcquisitionBudget is not a function", code: "ERR_CUSTOMER", frames: ["CustomerAcquisitionBudget server/src/main.ts:1"], title: "客户名单" },
    { at: new Date().toISOString(), src: "server", pid: 7, ev: "http.slow", route: "/api/tasks/abc123/customer", method: "GET", ms: 4000 },
    { at: new Date().toISOString(), src: "web", pid: 7, ev: "page.error", tab: "Customer42", name: "Error", frames: ["src/Customer/../lib/runtimeLog.ts:1"] },
    { at: new Date().toISOString(), src: "server", pid: 7, ev: "task.content", text: "客户名单" },
  ];
  appendFileSync(join(runtimeLogDir(), "server.jsonl"), `${legacy.map((line) => JSON.stringify(line)).join("\n")}\n`);
  runtimeLog("http.slow", { route: "/api/tasks/:id/messages", method: "GET", ms: 4000, status: 200 });
  const reread = loadDataDir(root).records;
  const exported = JSON.stringify(buildRuntimeLogBundle(null));
  assert.ok(!/Customer|abc123|客户/.test(exported), "旧记录里的原文、路径、标识不进导出包");
  assert.ok(!/Customer|abc123|客户/.test(JSON.stringify(reread)), "报告和时间线读到的也是投影之后的");
  const oldError = reread.find((r) => r.ev === "server.error" && r.pid === 7)!;
  assert.deepEqual(oldError, { at: oldError.at, src: "server", pid: 7, ev: "server.error", kind: "uncaught", name: "OtherError", code: "OTHER", frames: ["server/src/main.ts:1"] });
  assert.equal(reread.find((r) => r.ev === "http.slow" && r.pid === 7)!.route, undefined, "没有格式号的旧行，路由读回来核对不了，不留");
  assert.equal(reread.find((r) => r.ev === "page.error" && r.pid === 7)!.tab, undefined, "不是摘要的标识不留");
  assert.ok(!reread.some((r) => r.ev === "task.content"), "认不出的事件整条不要");
  assert.equal(serverLines().find((line) => line.ev === "http.slow" && line.pid === process.pid)?.v, shared.RUNTIME_LOG_SCHEMA, "当前写入端每行带格式号");
  assert.ok(reread.some((r) => r.ev === "http.slow" && r.route === "/api/tasks/:id/messages"), "带格式号的路由模板照留");
  // 更早版本导出的包（version 1）读的时候同样投影；version 2 是导出时投影过的。
  const oldBundle = join(root, "old-bundle.json");
  writeFileSync(oldBundle, JSON.stringify({ ...buildRuntimeLogBundle(null), version: 1, records: legacy, exits: [{ at: legacy[0]!.at, kind: "signal", signal: "SIGTERM; rm -rf", note: "x" }] }));
  const oldLoaded = loadRuntimeLogPath(oldBundle);
  assert.ok(!/Customer|abc123|客户|rm -rf/.test(JSON.stringify(oldLoaded)), JSON.stringify(oldLoaded.records));

  // 按窗口读时，窗口前最后一次服务启动作为上下文带上，别的窗口外记录不带。
  const day = 86_400_000;
  const now = Date.now();
  const record = (ago: number, ev: string) => ({ at: new Date(now - ago).toISOString(), src: "server", pid: 1, ev });
  const file = join(root, "bundle.json");
  writeFileSync(file, JSON.stringify({ ...bundle, records: [record(20 * day, "server.start"), record(10 * day, "server.start"), record(9 * day, "loop.stall"), record(3600_000, "server.start")] }));
  const windowed = loadRuntimeLogPath(file, now - 7 * day);
  assert.deepEqual(windowed.records.map((r) => [r.ev, Math.round((now - Date.parse(r.at)) / day)]), [["server.start", 10], ["server.start", 0]]);
}

rmSync(root, { recursive: true, force: true });
console.log("[runtime-log] ok");
process.exit(0);
