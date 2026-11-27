// 上下文分项(claude `get_context_usage`)从请求到落库的一整条:
//   ① 回执 → 快照:分类原样、MCP 工具按服务聚合、方格画不留、认不出的形状给 null
//   ② 控制请求的往返:请求号不撞打断那一路,报错 / 超时 / 进程没了都给 null、从不抛
//   ③ 单飞收台:请求与关 stdin 同一刻写出,回执到了先吐分项再 done;CLI 不认、不理、先退了都照常收台,
//      不多等(等的上限只给真卡住的那一种);写 stdin 本身卡住也在同一个期限里
//   ④ 落库覆盖式、带回合起点,读回来跟写进去的一样;只认更新的那份;坏 JSON 当没有
//   ⑤ 调度台:乱序回执、被接管后旧台的回执都写不进去、也不广播
// 对面是按 stream-json 说话的假 CLI 子进程,走真实的 ClaudeExecutor.attach → residentFromChild →
// parseClaudeStream → singleRunFromResident。
//   npm -w server run test:context-breakdown
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentEvent } from "@navi/shared";

const root = mkdtempSync(join(tmpdir(), "navi-context-breakdown-"));
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const [{ ensureSchema, db }, { sessions }, { ClaudeExecutor }, { ClaudeControlBridge }, breakdownModule, usage] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/executors/claude.js"),
  import("../src/executors/claude-control.js"),
  import("../src/executors/claude-context-breakdown.js"),
  import("../src/usage.js"),
]);
const { parseClaudeContextUsage, parseStoredContextBreakdown } = breakdownModule;
await ensureSchema();
// 等回执的定时器 unref 了(不替 navi 拖住退出),测试进程里得另有东西撑着事件循环。
const keepAlive = setInterval(() => {}, 1000);

// claude 2.1.283 的真实回执(mcpTools 截了几条,gridRows 截成一行)。
const reply = {
  categories: [
    { name: "System prompt", tokens: 6795, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 36864, color: "inactive", kind: "used" },
    { name: "MCP tools", tokens: 1640, color: "cyan_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Memory files", tokens: 36, color: "claude", kind: "used" },
    { name: "Skills", tokens: 1986, color: "warning", kind: "used" },
    { name: "Messages", tokens: 19810, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
    { name: "Free space", tokens: 99869, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 67131,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  autocompactSource: "env",
  percentage: 34,
  gridRows: [[{ color: "promptBorder", isFilled: true, categoryName: "System prompt", tokens: 6795, percentage: 3, squareFullness: 1 }]],
  model: "claude-haiku-4-5-20251001",
  memoryFiles: [{ path: "/Users/u/.claude/CLAUDE.md", type: "User", tokens: 36 }],
  mcpTools: [
    { name: "mcp__kb__kb_search", serverName: "kb", tokens: 754, isLoaded: false },
    { name: "mcp__navi__get_task", serverName: "navi", tokens: 600, isLoaded: false },
    { name: "mcp__kb__kb_read", serverName: "kb", tokens: 138, isLoaded: false },
    { name: "mcp__navi__run_task", serverName: "navi", tokens: 148, isLoaded: false },
  ],
  agents: [],
  slashCommands: { totalCommands: 49, includedCommands: 49, tokens: 1403 },
  skills: { totalSkills: 49, includedSkills: 47, tokens: 1986, skillFrontmatter: [{ name: "brandkit", source: "userSettings", tokens: 3 }] },
  autoCompactThreshold: 167000,
  isAutoCompactEnabled: true,
  messageBreakdown: { toolCallTokens: 0 },
  apiUsage: { input_tokens: 10 },
};
const AT = "2026-11-27T08:00:00.000Z";

// ① 回执 → 快照
{
  const parsed = parseClaudeContextUsage(reply, AT);
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    at: AT,
    turnStartedAt: null,
    model: "claude-haiku-4-5-20251001",
    total: 67131,
    max: 200000,
    autoCompactThreshold: 167000,
    categories: reply.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
    mcpServers: [{ name: "kb", tokens: 892, tools: 2 }, { name: "navi", tokens: 748, tools: 2 }],
    memoryFiles: [{ path: "/Users/u/.claude/CLAUDE.md", type: "User", tokens: 36 }],
    skills: { total: 49, included: 47, tokens: 1986 },
  });
  assert.ok(!JSON.stringify(parsed).includes("squareFullness"), "TUI 方格画不留");
  assert.equal(parseClaudeContextUsage({ ...reply, isAutoCompactEnabled: false }, AT)?.autoCompactThreshold, null,
    "没开自动压缩就没有触发点");
  const renamed = parseClaudeContextUsage({ categories: [{ name: "Something new", tokens: 12 }] }, AT);
  assert.deepEqual(renamed?.categories, [{ name: "Something new", tokens: 12, kind: "used" }], "认不出的分类名原样留着");
  assert.equal(renamed?.total, 12, "没报合计就按占用份加");
  for (const bad of [null, "x", {}, { categories: "x" }, { categories: [{ tokens: 1 }] }]) {
    assert.equal(parseClaudeContextUsage(bad, AT), null, `形状认不出给 null:${JSON.stringify(bad)}`);
  }
  console.log("✓ 回执 → 快照:分类原样、MCP 按服务聚合、方格画不留、认不出的形状给 null");
}

// ② 控制请求往返
{
  const bridge = new ClaudeControlBridge();
  const ok = bridge.query("get_context_usage", { detail: "summary" }, 1_000);
  const sent = JSON.parse(ok.line);
  assert.equal(sent.type, "control_request");
  assert.deepEqual(sent.request, { subtype: "get_context_usage", detail: "summary" });
  assert.ok(!sent.request_id.startsWith("navi_int_"), "请求号不跟打断那一路共用前缀");
  const interrupt = bridge.request();
  const ack = bridge.waitFor(interrupt.requestId);
  bridge.handleResponse({ type: "control_response", response: { subtype: "success", request_id: sent.request_id, response: { totalTokens: 1 } } });
  assert.deepEqual(await ok.reply, { totalTokens: 1 });
  bridge.handleResponse({ type: "control_response", response: { subtype: "success", request_id: interrupt.requestId } });
  await ack.promise; // 打断那一路照常配对,没被查询抢走

  const refused = bridge.query("get_context_usage", {}, 1_000);
  bridge.handleResponse({ type: "control_response", response: { subtype: "error", request_id: JSON.parse(refused.line).request_id, error: "Unsupported control request subtype" } });
  assert.equal(await refused.reply, null, "CLI 不认就是 null");

  const started = Date.now();
  assert.equal(await bridge.query("get_context_usage", {}, 30).reply, null, "超时是 null");
  assert.ok(Date.now() - started < 500);

  const orphan = bridge.query("get_context_usage", {}, 10_000);
  bridge.failPending(new Error("进程没了"));
  assert.equal(await orphan.reply, null, "进程没了是 null,不抛");
  console.log("✓ 控制请求往返:跟打断各配各的,报错 / 超时 / 进程没了都是 null");
}

// ③ 单飞收台
const line = (value: unknown) => JSON.stringify(value) + "\n";
const result = { type: "result", subtype: "success", num_turns: 1, result: "好了", session_id: "sess-c" };
const turn = [
  { type: "system", subtype: "init", session_id: "sess-c" },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "好了\n" } } },
  { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "好了" }] } },
  result,
];

type StubOpts = { exitOnEof?: boolean; exitAfterTurn?: boolean; jam?: boolean };
/**
 * 假 CLI:吐完一个回合;收到控制请求按 `onControl` 回;`exitOnEof` 读到 EOF 就退;`exitAfterTurn` 回合说完就退;
 * `jam` 一个字都不读 stdin,测试先往管道里塞满 8 MiB —— 之后再写什么都卡在写队列里。
 */
function stubCli(name: string, onControl: string, opts: StubOpts = {}) {
  const script = join(root, `${name}.cjs`);
  writeFileSync(script, `
const readline = require("node:readline");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = ${JSON.stringify(reply)};
if (!${!!opts.jam}) readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const message = JSON.parse(raw);
  process.stderr.write("INPUT " + message.type + " " + (message.request ? message.request.subtype : "") + "\\n");
  if (message.type === "control_request") { ${onControl} }
}).on("close", () => { process.stderr.write("STDIN_CLOSED\\n"); if (${opts.exitOnEof !== false}) process.stdout.write("", () => process.exit(0)); });
for (const value of ${JSON.stringify(turn)}) emit(value);
if (${!!opts.exitAfterTurn}) process.stdout.write("", () => process.exit(0));
setTimeout(() => process.exit(0), 20000);
`);
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  if (opts.jam) child.stdin.write(Buffer.alloc(8 * 1024 * 1024, 0x20));
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  return { child, stderr: () => stderr };
}

const executor = new ClaudeExecutor();
async function runTurn(name: string, onControl: string, opts?: StubOpts) {
  const stub = stubCli(name, onControl, opts);
  const handle = executor.attach(stub.child, { sessionId: "sess-c", commandLine: "claude -p --input-format stream-json" });
  const started = Date.now();
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const ms = Date.now() - started;
  // 等它自己退(stderr 收齐);读到 EOF 也不走的那种过一会儿收掉。
  if (stub.child.exitCode === null) {
    await new Promise((resolve) => { stub.child.once("close", resolve); setTimeout(resolve, 1_000); });
  }
  stub.child.kill();
  return { events, ms, stderr: stub.stderr() };
}
const kinds = (events: AgentEvent[]) => events.map((event) => event.kind).filter((kind) => kind === "contextBreakdown" || kind === "done");

{
  const answer = `emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: reply } });`;
  const { events, stderr } = await runTurn("answers", answer);
  assert.deepEqual(kinds(events), ["contextBreakdown", "done"], "分项排在 done 之前");
  const event = events.find((e) => e.kind === "contextBreakdown");
  assert.equal(event?.kind === "contextBreakdown" ? event.breakdown.total : null, 67131);
  assert.deepEqual(stderr.split("\n").filter((l) => l.startsWith("INPUT ") || l === "STDIN_CLOSED"),
    ["INPUT control_request get_context_usage", "STDIN_CLOSED"], "请求在关 stdin 之前写出");
  console.log("✓ 单飞收台:请求与关 stdin 同一刻写出,回执到了先吐分项再 done");
}
{
  const refuse = `emit({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Unsupported control request subtype: get_context_usage" } });`;
  const refused = await runTurn("refuses", refuse);
  assert.deepEqual(kinds(refused.events), ["done"], "老 CLI 不认:不留分项,照常 done");
  const ignored = await runTurn("ignores", "");
  assert.deepEqual(kinds(ignored.events), ["done"], "不理这个请求、读到 EOF 就退:照常 done");
  assert.ok(ignored.ms < 3_000, `不理请求的 CLI 一退就收台,不等满上限(用了 ${ignored.ms}ms)`);
  const gone = await runTurn("gone", "", { exitAfterTurn: true });
  assert.deepEqual(kinds(gone.events), ["done"], "回合说完进程就没了:不崩、照常 done");
  console.log("✓ CLI 不认、不理、先退了:不留分项、照常收台,不多等");
}
{
  // 真卡住(不回、读到 EOF 也不走)的那一种才等满上限,上限之后照常 done,不拖住结算。
  const { events, ms } = await runTurn("stuck", "", { exitOnEof: false });
  assert.deepEqual(kinds(events), ["done"]);
  assert.ok(ms >= 4_500 && ms < 8_000, `卡住的 CLI 等满上限就收台(用了 ${ms}ms)`);
  console.log("✓ 卡住的 CLI:等满上限照常收台");
}

{
  // 写进 stdin 就卡住(管道积压、CLI 不读输入):期限盖住整件事,不单独等写回调。
  const { events, ms } = await runTurn("jammed", "", { jam: true });
  assert.deepEqual(kinds(events), ["done"]);
  assert.ok(ms < 8_000, `写卡住也在上限内收台(用了 ${ms}ms)`);
  console.log("✓ 写 stdin 卡住:同一个期限内照常收台");
}

// ④ 落库
{
  await db.insert(sessions).values({ id: "sess-row", taskId: "task-c", role: "single", agentType: "claude", executor: "claude", startedAt: AT });
  const read = async () => usage.sessionContextBreakdown((await db.select().from(sessions).where(eq(sessions.id, "sess-row")))[0]!);
  assert.equal(await read(), null, "没取到过就是 null");
  const parsed = parseClaudeContextUsage(reply, AT)!;
  await usage.setSessionContextBreakdown("sess-row", parsed, "2026-11-27T07:59:00.000Z");
  assert.deepEqual(await read(), { ...parsed, turnStartedAt: "2026-11-27T07:59:00.000Z" }, "读回来跟写进去的一样,带回合起点");
  const newer = { ...parsed, at: "2026-11-27T09:00:00.000Z", total: 1 };
  await usage.setSessionContextBreakdown("sess-row", newer, null);
  assert.deepEqual(await read(), { ...newer, turnStartedAt: null }, "覆盖不累加");
  assert.equal(await usage.setSessionContextBreakdown("sess-row", { ...parsed, at: "2026-11-27T08:30:00.000Z", total: 2 }, null), false,
    "比库里那份早问的不写");
  assert.equal((await read())?.total, 1, "晚到的旧回执盖不掉新的");
  assert.equal(parseStoredContextBreakdown("{坏的"), null);
  assert.equal(parseStoredContextBreakdown(JSON.stringify({ at: AT, categories: [] })), null, "空表当没有");
  console.log("✓ 落库覆盖式、带回合起点;坏 JSON 当没有");
}
// ⑤ 调度台:回执乱序到、被接管之后旧台的回执到,都写不进去、也不广播
{
  const { noteContextBreakdown } = await import("../src/team/lead-session-writes.js");
  const { bus } = await import("../src/bus.js");
  await db.insert(sessions).values({ id: "lead-row", taskId: "task-lead", role: "lead", agentType: "claude", executor: "claude", startedAt: AT, leadHolder: "old" });
  const broadcast: number[] = [];
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "agent.event" && event.event.kind === "contextBreakdown") broadcast.push(event.event.breakdown.total);
  });
  const pending: ((value: any) => void)[] = [];
  const lead = {
    taskId: "task-lead", sessId: "lead-row", holder: "old", retired: false, agentType: "claude", model: null, reasoningEffort: null, turnStart: null,
    handle: { contextBreakdown: () => new Promise((resolve) => pending.push(resolve)) },
  } as any;
  const base = parseClaudeContextUsage(reply, AT)!;
  const stored = async () => usage.sessionContextBreakdown((await db.select().from(sessions).where(eq(sessions.id, "lead-row")))[0]!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  noteContextBreakdown(lead, "turn-1");
  noteContextBreakdown(lead, "turn-2");
  pending[1]!({ ...base, at: "2026-11-27T08:02:00.000Z", total: 200 }); // 后问的先回
  await settle();
  pending[0]!({ ...base, at: "2026-11-27T08:01:00.000Z", total: 100 });
  await settle();
  assert.equal((await stored())?.total, 200, "先问的回执晚到,盖不掉后问的");
  assert.deepEqual(broadcast, [200], "没写进去的不广播");

  // 新台接管了这一行(代次换了),旧台手上还没收回来的回执到了:一笔都不写。
  noteContextBreakdown(lead, "turn-3");
  await db.update(sessions).set({ leadHolder: "new" }).where(eq(sessions.id, "lead-row"));
  pending[2]!({ ...base, at: "2026-11-27T08:03:00.000Z", total: 300 });
  await settle();
  assert.equal((await stored())?.total, 200, "被接管之后旧台写不进去");
  assert.deepEqual(broadcast, [200]);
  unsubscribe();
  console.log("✓ 调度台:乱序到的旧回执、被接管后旧台的回执都写不进去,也不广播");
}
clearInterval(keepAlive);
process.exit(0);
