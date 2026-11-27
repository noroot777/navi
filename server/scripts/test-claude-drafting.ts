// 正在生成的那一步要直播出去（claude-drafting.ts）：模型写一份上万字的文件时，入参要生成好几分钟，
// 这期间流里别的什么都没有，页面看着就是停住了（qfix1xZNymhT 的用户以为它没在干活，追问打断了四次）。
// 两层：折叠器本身的节奏与说法；真解析器读假 CLI 的流，在工具行之前吐出 drafting。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-claude-drafting-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const [{ ensureSchema }, { claudeDrafting }, { parseClaudeStream }, { ClaudeControlBridge }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/executors/claude-drafting.js"),
  import("../src/executors/claude.js"),
  import("../src/executors/claude-control.js"),
]);
await ensureSchema();

const start = (name: string) => ({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } });
const delta = (partial_json: string) => ({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } });

try {
  // 1. 节奏：开头两秒不报、之后每秒最多一次；这一块结束、新消息开始、正文块都不报。
  {
    const d = claudeDrafting();
    const t0 = 1_000_000;
    assert.equal(d.event(start("Write"), t0), null);
    assert.equal(d.event(delta('{"file_path":"/repo/docs/\\u65b9\\u6848.md","content":"# '), t0 + 500), null, "开头两秒不报");
    const first = d.event(delta("第一节……"), t0 + 2_100);
    assert.ok(first, "两秒之后报出来");
    assert.equal(first!.tool, "Write");
    assert.equal(first!.target, "方案.md", "入参里的路径解出来，只留文件名");
    assert.ok(first!.chars > 40);
    assert.equal(first!.since, new Date(t0).toISOString(), "从开始生成那一刻算");
    assert.equal(d.event(delta("x"), t0 + 2_600), null, "一秒内不重复报");
    const second = d.event(delta("y"), t0 + 3_200);
    assert.equal(second!.chars, first!.chars + 2, "字数跟着往上走");
    assert.equal(d.event({ type: "content_block_stop", index: 0 }, t0 + 3_300), null);
    assert.equal(d.event(delta("z"), t0 + 5_000), null, "这一块结束就不再报");

    assert.equal(d.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, t0), null);
    assert.equal(d.event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, t0 + 9_000), null, "正文块不归它管");

    d.event(start("Bash"), t0);
    d.event({ type: "message_start", message: {} }, t0 + 100);
    assert.equal(d.event(delta('{"command":"ls"}'), t0 + 3_000), null, "新消息开始，上一条没生成完的作废");

    d.event(start("Bash"), t0);
    const bash = d.event(delta('{"command":"cat <<EOF > a.md'), t0 + 2_500);
    assert.equal(bash!.tool, "Bash");
    assert.equal(bash!.target, undefined, "没有路径字段就不猜");
    console.log("✓ 正在生成的那一步：两秒后开始报、每秒一次，结束即停");
  }

  // 2. 真解析器：假 CLI 把一次 Write 的入参分两段流出来，中间停 2.2 秒。
  {
    const sid = "drafting-session";
    const lines = [
      { type: "system", subtype: "init", session_id: sid },
      { type: "stream_event", session_id: sid, event: { type: "message_start", message: {} } },
      { type: "stream_event", session_id: sid, event: start("Write") },
      { type: "stream_event", session_id: sid, event: delta('{"file_path":"/repo/doc.md","content":"长文') },
      "PAUSE",
      { type: "stream_event", session_id: sid, event: delta('第二段"}') },
      { type: "stream_event", session_id: sid, event: { type: "content_block_stop", index: 0 } },
      { type: "assistant", session_id: sid, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "/repo/doc.md", content: "长文第二段" } }] } },
      { type: "result", subtype: "success", session_id: sid },
    ];
    const script = join(root, "stub.mjs");
    writeFileSync(script, `const lines = ${JSON.stringify(lines)};
const emit = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
(async () => {
  for (const line of lines) {
    if (line === "PAUSE") { await new Promise((r) => setTimeout(r, 2200)); continue; }
    emit(line);
  }
})();
`);
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.end();
    const events: any[] = [];
    for await (const event of parseClaudeStream(child as any, new ClaudeControlBridge())) events.push(event);
    const kinds = events.map((event) => event.kind);
    const at = kinds.indexOf("drafting");
    assert.ok(at >= 0, `应吐出 drafting，实际 ${kinds.join(",")}`);
    assert.equal(events[at].target, "doc.md");
    assert.ok(at < kinds.indexOf("tool"), "drafting 排在这一步的工具行之前");
    console.log("✓ claude 解析器在工具行之前直播正在生成的那一步");
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
