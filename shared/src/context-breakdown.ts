// 上下文**分项**:此刻窗口里各类东西各占多少(系统提示、内置工具、MCP 工具、记忆文件、技能、
// 对话消息、自动压缩预留、剩余空间)。纯类型,index 只做 `export type` 转发(见 events.ts 文件头)。
//
// 跟 ContextUsage(shared/src/usage.ts)是两份东西,别并成一个:水位每次 API 调用都覆盖一遍,
// 分项只在**回合结束**时问 CLI 一次(claude 的 `get_context_usage` 控制请求,见
// server/src/executors/claude-context-breakdown.ts)。两者时刻不同,数也就对不齐 —— 分项带自己
// 的取数时刻,界面照实写「几分钟前」。
//
// 只有 claude 给得出来。codex app-server 只报总数和窗口,没有任何分项方法;不估算冒充。

/** 一项。`name` 按 CLI 原样存(「System prompt」「MCP tools」…),中文名由界面映射,认不出的原样显示。 */
export interface ContextBreakdownCategory {
  name: string;
  tokens: number;
  /** used = 实际占着的;buffer = 自动压缩预留;free = 还空着的。三类加起来是整个窗口。 */
  kind: "used" | "buffer" | "free";
}

/** 一个 MCP 服务器名下全部工具的说明合计占多少(按服务器聚合,不存逐个工具)。 */
export interface ContextBreakdownMcpServer {
  name: string;
  tokens: number;
  tools: number;
}

export interface ContextBreakdown {
  /** 取到这份分项的时刻。 */
  at: string;
  /** 来自哪个回合(会话的 turn_started_at);说不上来是 null。 */
  turnStartedAt: string | null;
  model: string | null;
  /** 已占用合计(= kind:"used" 那几项之和)。 */
  totalTokens: number;
  /** 这一份分项按多大的窗口算的;各项占比的分母。 */
  maxTokens: number;
  /** 到多少 token 自动压缩;没开自动压缩是 null。 */
  autoCompactThreshold: number | null;
  categories: ContextBreakdownCategory[];
  mcpServers: ContextBreakdownMcpServer[];
  skills: { total: number; included: number; tokens: number } | null;
  memoryFiles: { path: string; type: string; tokens: number }[];
}
