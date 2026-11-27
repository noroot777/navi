// 上下文分项：单飞回合 `result` 之后、收台之前问一次 `get_context_usage`，分项随事件流交出来；
// 问不到（没自报版本、CLI 不认、超时）照常收台，不留快照、不拖结算。另测回包/落库两头的解析。
import "./isolated-data.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
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

  // ⑥ 一决定收台就不再收插话：等分项的那几秒里插话当场拒收、一个字不送（留在队列里由下一回合送）。
  {
    let sent = 0;
    let rejected: unknown = null;
    const fake = {
      sessionId: "closing", commandLine: "x", launchCompact: null,
      events: (async function* () { yield { kind: "turnEnd", epoch: 0 } as AgentEvent; })(),
      epoch: () => 0, turnActive: () => false,
      contextBreakdown: async () => {
        await run.steer!("插一句").catch((error) => { rejected = error; });
        return contextBreakdownFromClaude(USAGE, "t");
      },
      send: () => { sent += 1; return true; },
      close: () => {}, kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const run = singleRunFromResident(fake);
    const seen: string[] = [];
    for await (const event of run.events) seen.push(event.kind);
    assert.match(String(rejected), /当前回合已经结束/, "等分项时插话当场拒收");
    assert.equal(sent, 0, "一个字都没送进去");
    assert.deepEqual(seen, ["contextBreakdown", "done"]);
  }
  console.log("✓ 决定收台后插话当场拒收，不跟收台抢");

  // ⑥b 等分项的那几秒里 CLI 自己开了下一回合（完成通知到了）：这个结尾作废，不收台、分项不要，重新收插话，
  //     新回合结尾再问一次分项再收台。
  {
    let epoch = 0;
    let active = false;
    let closed = false;
    let release: () => void = () => {};
    const nextTurn = new Promise<void>((resolve) => { release = resolve; });
    let asks = 0;
    let steerDuringNewTurn: Promise<void> | undefined;
    const fake = {
      sessionId: "race", commandLine: "race", launchCompact: null,
      events: (async function* () {
        yield { kind: "turnEnd", epoch: 0 } as AgentEvent;
        await nextTurn;
        yield { kind: "text", text: "新回合在干活" } as AgentEvent;
        yield { kind: "turnEnd", interrupted: true } as AgentEvent; // 插话打断出来的那个结尾
        active = false;
        yield { kind: "turnEnd", epoch: 2 } as AgentEvent;
      })(),
      epoch: () => epoch,
      turnActive: () => active,
      contextBreakdown: async () => {
        asks += 1;
        if (asks === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          epoch = 1;
          active = true;
          release();
        }
        return contextBreakdownFromClaude(USAGE, "t");
      },
      steer: async (_text: unknown, onInterrupted?: () => void) => { onInterrupted?.(); epoch = 2; },
      send: () => true,
      close: () => { closed = true; },
      kill: () => {}, interrupt: () => {},
      cleanup: async () => ({ kind: "empty" }),
    } as unknown as ResidentHandle;
    const run = singleRunFromResident(fake);
    const seen: string[] = [];
    let closedBeforeNewTurnEnded = false;
    for await (const event of run.events) {
      seen.push(event.kind);
      if (event.kind === "text") {
        closedBeforeNewTurnEnded = closed;
        steerDuringNewTurn = run.steer!("新回合里插一句");
      }
    }
    await steerDuringNewTurn;
    assert.equal(closedBeforeNewTurnEnded, false, "新回合在干活时没被收台");
    assert.deepEqual(seen, ["text", "contextBreakdown", "done"], "旧结尾的分项不要，新回合结尾照常问一次再收台");
    assert.equal(asks, 2);
    assert.equal(closed, true);
  }
  console.log("✓ 等分项时 CLI 开了新回合：不截断，重新收插话，新回合结尾再收台");

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

  console.log("✓ 先关 stdin 再交分项和结束");

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

  // ⑧ 常驻调度台：取数回来、等数据库空闲的那段里同一行被新台接管，旧台这一笔落空、也不播；
  // 还是自己那一行就照常写、照常播。用事务占住库，把「过了 retired 检查 → 被接管 → 语句执行」排稳。
  {
    const { dbClient, ensureSchema } = await import("../src/db/index.js");
    const { createSessionConsumer } = await import("../src/team/session-consumer.js");
    const { bus } = await import("../src/bus.js");
    await ensureSchema();
    const at = new Date().toISOString();
    const snapshot = (n: number) => ({
      at, turnStartedAt: null, model: "claude", totalTokens: n, maxTokens: 200000, autoCompactThreshold: null,
      categories: [{ name: "Messages", tokens: n, kind: "used" as const }], mcpServers: [], skills: null, memoryFiles: [],
    });
    await dbClient.execute({ sql: "INSERT INTO projects(id,name,repo_path,created_at) VALUES('p','p',?,?)", args: [root, at] });
    await dbClient.execute({ sql: "INSERT INTO tasks(id,project_id,title,body,status,created_at,updated_at) VALUES('t','p','t','','done',?,?)", args: [at, at] });
    const storedTokens = async (id: string) => {
      const row = (await dbClient.execute({ sql: "SELECT context_breakdown FROM sessions WHERE id=?", args: [id] })).rows[0];
      return row?.context_breakdown ? JSON.parse(String(row.context_breakdown)).totalTokens : null;
    };
    const published: string[] = [];
    const unsubscribe = bus.subscribe((ev) => {
      const event = (ev as { event?: AgentEvent }).event;
      if (event?.kind === "contextBreakdown") published.push(`${(ev as { sessionId?: string }).sessionId}:${event.breakdown.totalTokens}`);
    });
    const leadFor = (sessId: string, tokens: number, asked: () => void, streamGate: Promise<void>): any => ({
      taskId: "t", sessId, cliSessionId: "cli", agentType: "claude", ownerUserId: null, executorId: null, model: null,
      reasoningEffort: null, cwd: root, holder: "old", busy: false, turnStart: null, pending: [], notices: [],
      pendingCredential: null, wantedStatus: null, statusTimer: null, idleTimer: null, retired: false, closing: null,
      out: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      handle: {
        events: (async function* () { yield { kind: "turnEnd" }; await streamGate; })(),
        contextBreakdown: async () => { asked(); return snapshot(tokens); },
        kill() {}, close() {},
      },
    });
    const consumer = createSessionConsumer({ leads: new Map(), adoptInbound: async () => {}, flushUnqueued: async () => {}, releasePending: () => {} });
    try {
      for (const [sessId, takenOver] of [["s-taken", true], ["s-own", false]] as const) {
        await dbClient.execute({
          sql: "INSERT INTO sessions(id,task_id,agent_type,executor,role,started_at,lead_holder) VALUES(?,'t','claude','claude@local','lead',?,'old')",
          args: [sessId, at],
        });
        let releaseStream!: () => void;
        let asked!: () => void;
        const askedGate = new Promise<void>((resolve) => { asked = resolve; });
        const lead = leadFor(sessId, 111, asked, new Promise<void>((resolve) => { releaseStream = resolve; }));
        const tx = await dbClient.transaction();
        const consuming = consumer.consume(lead);
        await askedGate;
        await new Promise((resolve) => setImmediate(resolve)); // 回调过了 retired 检查，卡在等库
        if (takenOver) {
          lead.retired = true;
          await tx.execute({ sql: "UPDATE sessions SET lead_holder='new', context_breakdown=? WHERE id=?", args: [JSON.stringify(snapshot(222)), sessId] });
        }
        await tx.commit();
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseStream();
        await consuming;
        assert.equal(await storedTokens(sessId), takenOver ? 222 : 111, takenOver ? "被接管的那一行不被旧台盖掉" : "自己那一行照常写");
      }
      assert.deepEqual(published, ["s-own:111"], "落空的那一笔不播");
    } finally {
      unsubscribe();
    }
    console.log("✓ 常驻调度台被接管后，旧台的分项既不落库也不播");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
