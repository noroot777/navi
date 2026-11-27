// 正在生成的那一步（shared events.ts 的 drafting）在气泡尾上挂一行：它在写哪个文件、写了多少字、写了多久。
// 模型生成一份长文件要好几分钟，这期间别的什么都不出，没有这一行页面就像停住了（qfix1xZNymhT）。
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DraftingEvent as Drafting } from "@navi/shared";
import { DraftingStrip } from "../src/components/DraftingStrip.tsx";
import { draftingLabel } from "../src/lib/executionWords.ts";

const drafting = (tool: string, target?: string, chars = 8240): Drafting => ({
  kind: "drafting", tool, ...(target ? { target } : {}), chars, since: new Date(Date.now() - 95_000).toISOString(),
});

assert.equal(draftingLabel(drafting("Write", "人员离职处理方案.md")), "正在写 人员离职处理方案.md · 已写 8,240 字");
assert.equal(draftingLabel(drafting("Edit", "README.md", 300)), "正在改 README.md · 已写 300 字");
assert.equal(draftingLabel(drafting("Bash", undefined, 1200)), "正在写命令 · 1,200 字");
assert.equal(draftingLabel(drafting("mcp__navi__suggest_dispatch", undefined, 50)), "正在准备 mcp__navi__suggest_dispatch · 50 字");
assert.equal(draftingLabel(drafting("Write")), "正在准备 Write · 8,240 字", "还没出路径时不编文件名");
console.log("✓ 正在生成的那一步说成人话");

const line = renderToStaticMarkup(<DraftingStrip drafting={drafting("Write", "方案.md")} />);
assert.match(line, /正在写 方案\.md · 已写 8,240 字/);
assert.match(line, /class="live-strip is-inline"[^>]*role="status"/, "跟进行条同一副长相，读屏会报");
assert.match(line, /live-strip-label shim/, "字上扫光：它在动");
assert.match(line, /live-strip-time/, "后面跟着这一步已经写了多久");
console.log("✓ 气泡尾上那一行：写什么、写了多少、写了多久");
