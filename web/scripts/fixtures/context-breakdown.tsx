import { createRoot } from "react-dom/client";
import type { ContextBreakdown, Session, Task } from "@navi/shared";
import { InspKv } from "../../src/inspector/parts.tsx";
import { InfoRunRows, InfoSessionRows } from "../../src/task-detail/info/InfoRunRows.tsx";
import type { InfoRunFacts } from "../../src/task-detail/info/infoRunFacts.ts";
import "../../src/styles/global.css";

// 「信息」格「上下文」那一行的分项（task-detail/info/ContextBreakdownRows.tsx）：左边一条带分项的 claude 会话，
// 右边一条 codex 会话（给不出分项，那一行照旧）。下面那几行（分支、目录）用来看展开时它们是不是顺势下移。
const at = new Date(Date.now() - 3 * 60_000).toISOString();
const breakdown: ContextBreakdown = {
  at,
  turnStartedAt: at,
  model: "claude-opus-5",
  totalTokens: 82_040,
  maxTokens: 200_000,
  autoCompactThreshold: 167_000,
  categories: [
    { name: "System prompt", tokens: 6_231, kind: "used" },
    { name: "System tools", tokens: 19_565, kind: "used" },
    { name: "MCP tools", tokens: 53_540, kind: "used" },
    { name: "Memory files", tokens: 153, kind: "used" },
    { name: "Skills", tokens: 1_986, kind: "used" },
    { name: "Messages", tokens: 565, kind: "used" },
    { name: "Something new", tokens: 0, kind: "used" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { name: "Free space", tokens: 84_960, kind: "free" },
  ],
  mcpServers: [{ name: "navi", tokens: 48_624, tools: 39 }, { name: "kb", tokens: 4_916, tools: 4 }],
  skills: { total: 49, included: 49, tokens: 1_986 },
  memoryFiles: [{ path: "/Users/x/.claude/CLAUDE.md", type: "User", tokens: 153 }],
};
const context = { used: 82_040, window: 200_000, windowEstimated: false };
const session = (id: string, agentType: string, extra: Partial<Session> = {}) => ({
  id, taskId: "t1", role: "single", agentType, executor: `${agentType}@local`, cliSessionId: `${id}-cli`,
  usage: null, context, branch: null, cwd: "/Users/x/code/demo", startedAt: at, endedAt: at, ...extra,
} as unknown as Session);
const task = { id: "t1", title: "演示", body: "", status: "done", createdAt: at, useWorktree: false } as unknown as Task;

function Panel({ testId, s, facts }: { testId: string; s: Session; facts: InfoRunFacts }) {
  return (
    <div className="task-inspector" data-testid={testId} style={{ width: 340, padding: 16, background: "var(--panel)" }}>
      <InspKv label="执行信息">
        <InfoRunRows task={task} sessions={[s]} facts={facts} />
        <InfoSessionRows task={task} session={s} notify={() => undefined} />
      </InspKv>
    </div>
  );
}

const claude = session("s1", "claude", { contextBreakdown: breakdown });
const codex = session("s2", "codex");
createRoot(document.getElementById("root")!).render(
  <main style={{ display: "flex", gap: 24, margin: "40px auto", width: 760 }}>
    <Panel testId="claude" s={claude} facts={{ session: claude, context, breakdown, compacting: false }} />
    <Panel testId="codex" s={codex} facts={{ session: codex, context, breakdown: null, compacting: false }} />
  </main>,
);
