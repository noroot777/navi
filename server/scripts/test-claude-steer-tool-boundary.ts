// claude 的引导是当场打断，打断落在一次工具调用的入参生成到一半时，CLI 把这次调用整个扔掉：
// qfix1xZNymhT 里智能体在写一份上万字的文档，用户三次引导问进度，三次打掉同一个 Write，文档始终
// 没写出来。引导先等手上那一步落地（ClaudeControlBridge.toolBoundary），等不到就留着排队。
// 三层：桥的记账与等待；真的 claude 执行器 + 假 CLI 的流里认出「正在生成」；引导端点等不到时
// 拒绝、消息原样排着、方向不动。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { RunHandle } from "../src/executors/types.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-claude-steer-tool-boundary-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");

const [{ db, ensureSchema }, schema, runs, steer, { ClaudeControlBridge }, { ClaudeExecutor }, { IS_WINDOWS }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-steer.js"),
  import("../src/executors/claude-control.js"),
  import("../src/executors/claude.js"),
  import("../src/platform.js"),
]);
await ensureSchema();

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const settled = <T>(promise: Promise<T>) => {
  const state: { done: boolean; value?: T } = { done: false };
  void promise.then((value) => { state.done = true; state.value = value; });
  return state;
};

let handle: RunHandle | null = null;
try {
  // 1. 桥：生成中一直等，到点答 generating；生成完给执行一小段；结果、新消息、回合结尾都能放行。
  {
    const bridge = new ClaudeControlBridge();
    assert.equal(await bridge.toolBoundary({ generatingMs: 1_000, runningMs: 1_000 }), "clear", "手上没东西不用等");

    bridge.noteToolStart("a");
    assert.equal(await bridge.toolBoundary({ generatingMs: 40, runningMs: 1_000 }), "generating", "入参一直没生成完，到点就别打断");

    const waiting = settled(bridge.toolBoundary({ generatingMs: 5_000, runningMs: 5_000 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(waiting.done, false, "还在生成就得等着");
    bridge.noteToolCall("a");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(waiting.done, false, "生成完了，执行还在限期里");
    bridge.noteToolResult("a");
    await waitFor(() => waiting.done, "出结果就放行");
    assert.equal(waiting.value, "clear");

    bridge.noteToolCall("b");
    const started = Date.now();
    assert.equal(await bridge.toolBoundary({ generatingMs: 5_000, runningMs: 60 }), "clear", "执行太久不等，照常打断");
    assert.ok(Date.now() - started >= 50, "执行限期要等满");
    bridge.noteToolResult("b");

    bridge.noteToolStart("c");
    const restarted = settled(bridge.toolBoundary({ generatingMs: 5_000, runningMs: 5_000 }));
    bridge.noteMessageStart();
    await waitFor(() => restarted.done, "新消息开始，没生成完的那次作废");
    assert.equal(restarted.value, "clear");

    bridge.noteToolStart("d");
    const ending = settled(bridge.toolBoundary({ generatingMs: 5_000, runningMs: 5_000 }));
    bridge.failPending(new Error("流没了"));
    await waitFor(() => ending.done, "流没了就放行");
    assert.equal(ending.value, "clear");
    console.log("✓ 引导等手上的工具调用：生成中等、执行限时、作废与收尾都放行");
  }

  // 2. 真执行器：假 CLI 流出一次 Write 的开头，入参生成完之前引导不得发打断。
  {
    const gatePath = join(root, "finish-tool");
    const requestPath = join(root, "request-id");
    const newInputPath = join(root, "new-input");
    const script = join(root, "fake-claude.mjs");
    const bin = IS_WINDOWS ? join(root, "claude.cmd") : script;
    writeFileSync(script, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sid = "tool-session";
let users = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    writeFileSync(${JSON.stringify(requestPath)}, message.request_id);
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted", session_id: sid });
    return;
  }
  if (message.type !== "user") return;
  users += 1;
  if (users > 1) {
    writeFileSync(${JSON.stringify(newInputPath)}, message.message.content[0].text);
    emit({ type: "result", subtype: "success", session_id: sid });
    return;
  }
  emit({ type: "system", subtype: "init", session_id: sid });
  emit({ type: "stream_event", session_id: sid, event: { type: "message_start", message: {} } });
  emit({ type: "stream_event", session_id: sid, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_write", name: "Write", input: {} } } });
  emit({ type: "stream_event", session_id: sid, event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\\"file_path\\":\\"doc.md\\"" } } });
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(gatePath)})) return;
    clearInterval(timer);
    const tool = { type: "tool_use", id: "toolu_write", name: "Write", input: { file_path: "doc.md", content: "长文" } };
    emit({ type: "assistant", session_id: sid, message: { role: "assistant", content: [tool] } });
    emit({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_write", content: "ok" }] } });
  }, 10);
});
`);
    if (IS_WINDOWS) writeFileSync(bin, `@node "%~dp0fake-claude.mjs" %*\r\n`);
    else chmodSync(bin, 0o755);
    process.env.NAVI_TEST_AGENT_BIN = bin;

    handle = new ClaudeExecutor({ bin }).runSteerable({ cwd: root, prompt: "写文档" });
    const consuming = (async () => { for await (const _ of handle!.events) { /* drain */ } })();
    // 等流里那次调用的开头被读到：在那之前问，答的是「手上没东西」。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const boundary = settled(handle.steerBoundary!());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(boundary.done, false, "Write 的入参还在生成，引导要等");
    assert.equal(existsSync(requestPath), false, "等的时候不能发打断");

    writeFileSync(gatePath, "go");
    await waitFor(() => boundary.done, "Write 落地后放行");
    assert.equal(boundary.value, "clear");
    await handle.steer!("进度如何？");
    await waitFor(() => existsSync(newInputPath), "打断之后新方向送进去");
    assert.equal(readFileSync(newInputPath, "utf8"), "进度如何？");
    await consuming;
    console.log("✓ claude 执行器从流里认出正在生成的工具调用，落地之前不打断");
  }

  // 3. 引导端点：等不到这一步落地就拒，消息原样排着、方向不动、没有打断。
  {
    const { projects, scheduledMessages, tasks } = schema;
    const at = new Date().toISOString();
    await db.insert(projects).values({ id: "p", name: "tool-boundary", repoPath: root, apiKeys: null, createdAt: at });
    await db.insert(tasks).values({
      id: "t", projectId: "p", title: "t", body: "test", mode: "single", status: "running",
      activeTurnToken: "t-turn", activeDirectionToken: "t-direction",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", createdAt: at, updatedAt: at,
    });
    await db.insert(scheduledMessages).values({
      id: "m", taskId: "t", text: "写到哪了？", attachments: "[]", mode: "queued", sendAt: at, status: "pending",
      createdAt: at, sentAt: null, deliveringSince: null,
    });
    const owner = runs.claimOwnTurn("t");
    assert.ok(owner);
    let boundary: "clear" | "generating" = "generating";
    const sent: string[] = [];
    const fake = {
      kill: () => { throw new Error("不得退回硬切"); },
      steerBoundary: async () => boundary,
      steer: async (text: string | (() => string | Promise<string>), beforeSend?: () => void | Promise<void>) => {
        await beforeSend?.();
        sent.push(typeof text === "function" ? await text() : text);
      },
    };
    runs.trackRun("t", fake);
    runs.bindNativeSteer("t", fake, { agentType: "claude", record: () => {} });

    const refused = await steer.steerQueuedMessage("m");
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /整个丢掉/);
    const row = async () => (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "m"))).at(0)!;
    const taskRow = async () => (await db.select().from(tasks).where(eq(tasks.id, "t"))).at(0)!;
    assert.equal((await row()).status, "pending", "消息继续排队");
    assert.equal((await row()).deliveringSince, null, "没被领走，托盘上撤得回来");
    assert.equal((await taskRow()).activeDirectionToken, "t-direction", "方向不动");
    assert.equal(sent.length, 0, "没有打断");

    boundary = "clear";
    assert.deepEqual(await steer.steerQueuedMessage("m"), { ok: true, taskId: "t", messageId: "m" }, "这一步落地后照常引导");
    assert.equal(sent.length, 1);
    assert.equal((await row()).status, "sent");
    runs.untrackRun("t", fake);
    runs.releaseTurn("t", owner);
    console.log("✓ 引导端点等不到这一步落地就拒，消息原样排着、方向不动");
  }
} finally {
  handle?.kill();
  await handle?.cleanup?.().catch(() => undefined);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
