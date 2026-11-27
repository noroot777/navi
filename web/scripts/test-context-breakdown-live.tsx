// 上下文分项(回合末向 claude 问来的那张表)在页面上的两件事:
//   ① 它是会话行上的一份快照,不是正文:直播里晚过回合收口到达,也不许在收过口的回合后面多出一颗空气泡
//      (团队调度台那一路不带身份号,走的是老的直播组装;单飞带身份号,走 conversationAssembler)
//   ② 分类名按原样存,认得的换中文,认不出的原样显示;占比按 CLI 的整个窗口算
import assert from "node:assert/strict";
import type { AgentEvent, ContextBreakdown } from "@navi/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { categoryLabel, categoryShare, categoryTone } from "../src/components/contextBreakdown.ts";

const TURN_START = "2026-11-27T08:00:00.000Z";
const session = {
  id: "s1", taskId: "t1", agentType: "claude", executor: "claude", role: "lead",
  startedAt: TURN_START, endedAt: null, turnStartedAt: TURN_START,
} as any;
const breakdown: ContextBreakdown = {
  at: "2026-11-27T08:01:00.000Z", turnStartedAt: TURN_START, model: "claude-opus-5", total: 60_000, max: 200_000,
  autoCompactThreshold: 167_000, mcpServers: [], memoryFiles: [], skills: null,
  categories: [
    { name: "Messages", tokens: 60_000, kind: "used" },
    { name: "Brand new thing", tokens: 500, kind: "used" },
    { name: "Free space", tokens: 139_500, kind: "free" },
  ],
};

// ① 不带身份号的直播(团队调度台):text → turnEnd → contextBreakdown
const live = (id: string, event: AgentEvent, extra: Record<string, unknown> = {}) => ({
  kind: "server" as const,
  id,
  event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "lead", agentType: "claude", event, ...extra } as any,
});
const plain = buildConversationItems([], [session], [
  live("l1", { kind: "text", text: "答完了。" }),
  live("l2", { kind: "turnEnd" }),
  live("l3", { kind: "contextBreakdown", breakdown }),
]);
assert.equal(plain.filter((item) => item.kind === "agent").length, 1, "回合收口之后到的分项又开了一颗空气泡");

// 带身份号的直播(单飞):分项不带号,同样不画
const identified = buildConversationItems([], [session], [
  live("i1", { kind: "text", text: "答完了。" }, { seq: 1, turnStartedAt: TURN_START }),
  live("i2", { kind: "turnEnd" }, { turnStartedAt: TURN_START, identityTurn: true }),
  live("i3", { kind: "contextBreakdown", breakdown }, { turnStartedAt: TURN_START, identityTurn: true }),
]);
assert.equal(identified.filter((item) => item.kind === "agent").length, 1, "带身份的那一路也把分项画成了气泡");
console.log("✓ 分项晚过回合收口到达,两条直播组装路都不多出空气泡");

// ②
assert.equal(categoryLabel("Messages"), "消息");
assert.equal(categoryLabel("Brand new thing"), "Brand new thing", "认不出的分类名原样显示");
assert.equal(categoryTone(breakdown.categories[1]!), "other");
assert.equal(categoryTone(breakdown.categories[2]!), "free");
assert.equal(categoryShare(60_000, breakdown), "30%");
assert.equal(categoryShare(500, breakdown), "<1%");
console.log("✓ 分类名认得的换中文、认不出的原样;占比按整个窗口算");
