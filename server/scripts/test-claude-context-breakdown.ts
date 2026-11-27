// 上下文分项：单飞回合 `result` 之后、收台之前问一次 `get_context_usage`，分项随事件流交出来；
// 问不到（没自报版本、CLI 不认、超时）照常收台，不留快照、不拖结算。另测回包/落库两头的解析。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@navi/shared";
import { ClaudeExecutor } from "../src/executors/claude.js";
import { ClaudeControlBridge } from "../src/executors/claude-control.js";
import { singleRunFromResident } from "../src/executors/claude-single-run.js";
import type { ResidentHandle } from "../src/executors/types.js";
import { contextBreakdownFromClaude, parseStoredContextBreakdown } from "../src/context-breakdown.js";
import { IS_WINDOWS } from "../src/platform.js";

const root = mkdtempSync(join(tmpdir(), "navi-claude-context-breakdown-"));

const USAGE = {
  categories: [
    { name: "System prompt", tokens: 6231, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 19565, color: "inactive", kind: "used" },
    { name: "MCP tools", tokens: 53540, color: "cyan_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Memory files", tokens: 153, color: "claude", kind: "used" },
    { name: "Messages", tokens: 2551, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
    { name: "Free space", tokens: 84960, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 82040,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 41,
  model: "claude-haiku-4-5-20251001",
  autoCompactThreshold: 167000,
  isAutoCompactEnabled: true,
  memoryFiles: [{ path: "/Users/x/.claude/CLAUDE.md", type: "User", tokens: 153 }],
  mcpTools: [
    { name: "mcp__kb__kb_read", serverName: "kb", tokens: 300, isLoaded: false },
    { name: "mcp__navi__get_task", serverName: "navi", tokens: 50000, isLoaded: false },
    { name: "mcp__navi__run_task", serverName: "navi", tokens: 3240, isLoaded: false },
  ],
  skills: { totalSkills: 3, includedSkills: 2, tokens: 1986, skillFrontmatter: [{ name: "a", tokens: 3 }] },
  gridRows: [[{ color: "x" }]],
};

/** 一份假 claude：首条 user → result；`mode` 决定它怎么对待分项请求。请求原文落到 `requests` 文件。 */
function fakeClaude(name: string, mode: "answer" | "silent" | "no-version"): string {
  const requests = join(root, `${name}.requests`);
  const script = join(root, `${name}.mjs`);
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const mode = ${JSON.stringify(mode)};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    appendFileSync(${JSON.stringify(requests)}, line + "\\n");
    if (mode === "answer") emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: ${JSON.stringify(USAGE)} } });
    return;
  }
  if (message.type !== "user") return;
  emit({ type: "system", subtype: "init", session_id: "ctx-session", ...(mode === "no-version" ? {} : { claude_code_version: "2.1.283" }) });
  emit({ type: "result", subtype: "success", session_id: "ctx-session", result: "hi" });
});
`);
  if (IS_WINDOWS) {
    const bin = join(root, `${name}.cmd`);
    writeFileSync(bin, `@node "%~dp0${name}.mjs" %*\r\n`);
    return bin;
  }
  chmodSync(script, 0o755);
  return script;
}

async function runOnce(name: string, mode: "answer" | "silent" | "no-version"): Promise<{ events: AgentEvent[]; ms: number; requests: string[] }> {
  const bin = fakeClaude(name, mode);
  process.env.NAVI_TEST_AGENT_BIN = bin;
  const handle = new ClaudeExecutor({ bin }).runSteerable({ cwd: root, prompt: "hi" });
  const started = Date.now();
  const events: AgentEvent[] = [];
  try {
    await Promise.race([
      (async () => { for await (const event of handle.events) events.push(event); })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name}: 单飞流没收尾`)), 15_000)),
    ]);
  } finally {
    handle.kill();
    await handle.cleanup?.().catch(() => undefined);
  }
  const path = join(root, `${name}.requests`);
  const requests = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
  return { events, ms: Date.now() - started, requests };
}

try {
  // ① 正常：结果之后问一次 full，分项在 done 之前交出来，MCP 按服务器合计，方格画不留。
  {
    const { events, requests } = await runOnce("answer", "answer");
    assert.equal(requests.length, 1, "回合结束问一次分项");
    const request = JSON.parse(requests[0]!);
    assert.equal(request.request.subtype, "get_context_usage");
    assert.equal(request.request.detail, "full");
    assert.match(request.request_id, /^navi_ctx_/);
    const kinds = events.map((event) => event.kind);
    const at = kinds.indexOf("contextBreakdown");
    assert.ok(at >= 0, "交出分项事件");
    assert.ok(at < kinds.indexOf("done"), "分项排在 done 之前");
    const breakdown = (events[at] as Extract<AgentEvent, { kind: "contextBreakdown" }>).breakdown;
    assert.equal(breakdown.maxTokens, 200000);
    assert.equal(breakdown.totalTokens, 82040);
    assert.equal(breakdown.autoCompactThreshold, 167000);
    assert.deepEqual(breakdown.categories.map((c) => [c.name, c.tokens, c.kind]), USAGE.categories.map((c) => [c.name, c.tokens, c.kind]));
    assert.deepEqual(breakdown.mcpServers, [{ name: "navi", tokens: 53240, tools: 2 }, { name: "kb", tokens: 300, tools: 1 }]);
    assert.deepEqual(breakdown.skills, { total: 3, included: 2, tokens: 1986 });
    assert.equal(breakdown.memoryFiles.length, 1);
    assert.ok(!("gridRows" in breakdown), "方格画不存");
    assert.ok(events.some((event) => event.kind === "done" && event.exitStatus === 0));
    console.log("✓ 单飞回合收台前问一次分项，分项排在 done 之前");
  }

  // ② 没在 init 里自报版本：不问，直接收台。
  {
    const { events, requests, ms } = await runOnce("no-version", "no-version");
    assert.equal(requests.length, 0, "没自报版本不发请求");
    assert.ok(!events.some((event) => event.kind === "contextBreakdown"));
    assert.ok(events.some((event) => event.kind === "done" && event.exitStatus === 0));
    assert.ok(ms < 3_000, `不白等超时（${ms}ms）`);
    console.log("✓ 没自报版本的 CLI 不问分项、不拖收台");
  }

  // ③ 问了没人答：等满超时照常收台，不留快照。
  {
    const { events, requests, ms } = await runOnce("silent", "silent");
    assert.equal(requests.length, 1);
    assert.ok(!events.some((event) => event.kind === "contextBreakdown"));
    assert.ok(events.some((event) => event.kind === "done" && event.exitStatus === 0), "超时照常收台");
    assert.ok(ms < 9_000, `最多多等超时上限（${ms}ms）`);
    console.log("✓ 分项超时：照常收台、不留快照");
  }

  // ④ CLI 不认这个子类型：当场 null，往后这个进程不再问；写不进 stdin 也是 null。
  {
    const bridge = new ClaudeControlBridge();
    assert.equal(await bridge.contextUsage(() => true, 50), null, "没自报版本直接 null");
    bridge.cliVersion = "2.0.0";
    const lines: string[] = [];
    const asking = bridge.contextUsage((line) => { lines.push(line); return true; }, 1_000);
    const id = JSON.parse(lines[0]!).request_id;
    bridge.handleResponse({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported control request subtype: get_context_usage" } });
    assert.equal(await asking, null);
    assert.equal(await bridge.contextUsage((line) => { lines.push(line); return true; }, 50), null);
    assert.equal(lines.length, 1, "不认就不再问");
    const closed = new ClaudeControlBridge();
    closed.cliVersion = "2.1.283";
    assert.equal(await closed.contextUsage(() => false, 1_000), null, "stdin 关了立刻 null");
    const dying = new ClaudeControlBridge();
    dying.cliVersion = "2.1.283";
    const pending = dying.contextUsage(() => true, 5_000);
    dying.failPending(new Error("进程没了"));
    assert.equal(await pending, null, "进程没了立刻 null，不抛");
    console.log("✓ 不认 / stdin 关了 / 进程没了：都是 null，从不抛");
  }

  // ⑥ 等分项的那几秒里换了回合（CLI 自己开的，或者插话直接送进去）：这个结尾作废，不收台、不报结束、
  //    分项不要，接着读流，新回合的结尾再收台；等的时候插话照收，不拒。
  for (const how of ["cli", "steer"] as const) {
    let epoch = 0;
    let active = false;
    let closed = false;
    let release: () => void = () => {};
    const nextTurn = new Promise<void>((resolve) => { release = resolve; });
    const fake = {
      sessionId: "race", commandLine: "race", launchCompact: null,
      events: (async function* () {
        yield { kind: "turnEnd", epoch: 0 } as AgentEvent;
        await nextTurn;
        yield { kind: "text", text: "新回合在干活" } as AgentEvent;
        active = false;
        yield { kind: "turnEnd", epoch: 1 } as AgentEvent;
      })(),
      epoch: () => epoch,
      turnActive: () => active,
      contextBreakdown: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (how === "cli") { epoch = 1; active = true; }
        else await run.steer!("插一句");
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        return contextBreakdownFromClaude(USAGE, "t");
      },
      send: () => { epoch = 1; active = true; return true; },
      close: () => { closed = true; },
      kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const run = singleRunFromResident(fake);
    const seen: string[] = [];
    let closedBeforeNewTurnEnded = false;
    for await (const event of run.events) {
      seen.push(event.kind);
      if (event.kind === "text") closedBeforeNewTurnEnded = closed;
    }
    assert.equal(closedBeforeNewTurnEnded, false, `${how}：新回合在干活时没被收台`);
    assert.deepEqual(seen, ["text", "contextBreakdown", "done"], `${how}：旧结尾的分项不要，新回合结尾照常问一次再收台`);
    assert.equal(closed, true);
  }
  console.log("✓ 等分项时换了回合：不截断新回合，插话照收，新回合结尾再收台");

  // ⑦ 收台的授权与收台同一步：消费方拿到分项后去写库（慢），那时 stdin 已经关了，不会是先交分项、
  //    等写库的空档里再凭旧核对收台。
  {
    let closed = false;
    const fake = {
      sessionId: "slow-consumer", commandLine: "x", launchCompact: null,
      events: (async function* () { yield { kind: "turnEnd", epoch: 0 } as AgentEvent; })(),
      epoch: () => 0, turnActive: () => false,
      contextBreakdown: async () => contextBreakdownFromClaude(USAGE, "t"),
      send: () => true, close: () => { closed = true; }, kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const seen: [string, boolean][] = [];
    for await (const event of singleRunFromResident(fake).events) {
      seen.push([event.kind, closed]);
      if (event.kind === "contextBreakdown") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(seen, [["contextBreakdown", true], ["done", true]], "先关 stdin，再交分项和结束");
  }

  // ⑧ 插话已经收下、还在准备正文时分项先回来了：等它送完（开了新回合），不收台、不让它送进一个关掉的 stdin。
  {
    let epoch = 0;
    let active = false;
    let closed = false;
    let sentWhileClosed: boolean | null = null;
    let steered: Promise<void> | undefined;
    let release: () => void = () => {};
    const nextTurn = new Promise<void>((resolve) => { release = resolve; });
    const fake = {
      sessionId: "pending-steer", commandLine: "x", launchCompact: null,
      events: (async function* () {
        yield { kind: "turnEnd", epoch: 0 } as AgentEvent;
        await nextTurn;
        active = false;
        yield { kind: "turnEnd", epoch: 1 } as AgentEvent;
      })(),
      epoch: () => epoch,
      turnActive: () => active,
      contextBreakdown: async () => {
        // 等分项时插话进来，准备正文要 50ms，分项 10ms 就回来了。
        steered = run.steer!("插一句", () => new Promise((resolve) => setTimeout(resolve, 50)));
        await new Promise((resolve) => setTimeout(resolve, 10));
        return contextBreakdownFromClaude(USAGE, "t");
      },
      send: () => { sentWhileClosed = closed; epoch = 1; active = true; release(); return true; },
      close: () => { closed = true; },
      kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const run = singleRunFromResident(fake);
    const seen: string[] = [];
    for await (const event of run.events) seen.push(event.kind);
    await steered;
    assert.equal(sentWhileClosed, false, "插话在 stdin 关之前送了进去");
    assert.deepEqual(seen, ["contextBreakdown", "done"], "旧结尾作废，新回合结尾才收台");
    assert.equal(closed, true);
  }
  console.log("✓ 收台与最后一次核对同一步：先关 stdin 再交分项；在途插话先落地");

  // ⑨ 等在途插话有终点：停止当场放行；准备一直不完就到点收台，那条插话发送失败（投递层退回排队）。
  for (const how of ["kill", "deadline"] as const) {
    let closed = false;
    let releasePrep: () => void = () => {};
    const prep = new Promise<void>((resolve) => { releasePrep = resolve; });
    let steered: Promise<void> | undefined;
    const fake = {
      sessionId: `stuck-${how}`, commandLine: "x", launchCompact: null,
      events: (async function* () { yield { kind: "turnEnd", epoch: 0 } as AgentEvent; })(),
      epoch: () => 0, turnActive: () => false,
      contextBreakdown: async () => {
        steered = run.steer!("插一句", () => prep);
        if (how === "kill") setTimeout(() => run.kill(), 30);
        return null;
      },
      send: () => !closed,
      close: () => { closed = true; }, kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const run = singleRunFromResident(fake, undefined, undefined, undefined, 200);
    const started = Date.now();
    const seen: string[] = [];
    for await (const event of run.events) seen.push(event.kind);
    const ms = Date.now() - started;
    assert.deepEqual(seen, ["done"]);
    assert.equal(closed, true);
    assert.ok(how === "kill" ? ms < 150 : ms >= 190 && ms < 1_000, `${how}：${ms}ms 收台`);
    releasePrep();
    await assert.rejects(steered!, /没收下/, `${how}：迟到的插话送不进关掉的 stdin，交回投递层`);
  }
  console.log("✓ 等在途插话有终点：停止当场放行，准备不完到点收台、迟到的插话交回投递层");

  // ⑤ 两头的解析：回包缺分项表或窗口就当没取到；落库那份读回来一致，坏的当没有。
  {
    assert.equal(contextBreakdownFromClaude({ categories: [], maxTokens: 1 }, "t"), null);
    assert.equal(contextBreakdownFromClaude({ categories: USAGE.categories }, "t"), null);
    const odd = contextBreakdownFromClaude({ ...USAGE, categories: [{ name: "Future thing", tokens: 10, kind: "weird" }] }, "t");
    assert.deepEqual(odd?.categories, [{ name: "Future thing", tokens: 10, kind: "used" }], "认不出的类别原样留着");
    assert.equal(contextBreakdownFromClaude({ ...USAGE, isAutoCompactEnabled: false }, "t")?.autoCompactThreshold, null);
    const parsed = contextBreakdownFromClaude(USAGE, "2026-11-27T00:00:00.000Z")!;
    const stored = { ...parsed, turnStartedAt: "2026-11-26T23:59:00.000Z" };
    assert.deepEqual(parseStoredContextBreakdown(JSON.stringify(stored)), stored);
    assert.equal(parseStoredContextBreakdown("{oops"), null);
    assert.equal(parseStoredContextBreakdown(JSON.stringify({ at: "x" })), null);
    assert.equal(parseStoredContextBreakdown(null), null);
    console.log("✓ 回包与落库两头的解析");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
