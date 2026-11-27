// ── 上下文分项 ───────────────────────────────────────────────────────────────
//
// 上下文里**装的是什么**:系统提示词、工具定义、MCP、记忆文件、技能、消息各占多少,外加自动压缩
// 预留与剩余空间。来源是 claude CLI 的 `get_context_usage` 控制请求(server 的
// executors/claude-context-breakdown.ts),跟 Claude 桌面版右侧栏那张表同一份数。
//
// **跟 ContextUsage(水位)分开存、分开显示**:水位每次 API 请求都更新,分项只在回合末问一次,
// 两者时刻不同 —— 界面要能说出「分项是几分钟前的」,所以快照自带取到的时刻。
//
// codex 没有对应的协议(app-server 只给 total/last token 与窗口),所以它的会话恒为 null,
// 不估算冒充。

/** CLI 对一份的归类:`used` 真占着的,`buffer` 自动压缩预留,`free` 剩余空间。 */
export type ContextBreakdownKind = "used" | "buffer" | "free";

export interface ContextBreakdownCategory {
  /** CLI 给的英文名,原样存(「System prompt」「MCP tools」…);中文名由展示端映射,认不出的原样显示。 */
  name: string;
  tokens: number;
  kind: ContextBreakdownKind;
}

/** 一个 MCP 服务的工具定义合计(CLI 逐个工具报,这里按服务聚合)。 */
export interface ContextBreakdownMcpServer {
  name: string;
  tokens: number;
  tools: number;
}

export interface ContextBreakdown {
  /** 取到这份分项的时刻。 */
  at: string;
  /** 它是哪一回合末取的(会话的 turnStartedAt);不知道是 null。 */
  turnStartedAt: string | null;
  model: string | null;
  /** 已占用合计(各 `used` 份之和)。 */
  total: number;
  /** CLI 认的窗口(各份之和,含预留与剩余)。 */
  max: number;
  /** CLI 在多少 token 时自动压缩;没开自动压缩或没报是 null。 */
  autoCompactThreshold: number | null;
  categories: ContextBreakdownCategory[];
  /** 「MCP tools」那一份按服务拆开,大的在前。 */
  mcpServers: ContextBreakdownMcpServer[];
  /** 「Memory files」那一份逐个文件(CLAUDE.md 之类),`type` 是 CLI 给的来源(User / Project …)。 */
  memoryFiles: { path: string; type: string; tokens: number }[];
  /** 「Skills」那一份的汇总:一共几个、装进去几个。没报是 null。 */
  skills: { total: number; included: number; tokens: number } | null;
}
