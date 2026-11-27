// claude CLI 的 `get_context_usage` 控制请求 → 上下文分项(shared ContextBreakdown)。
//
// stream-json 模式下往 stdin 写
//   {"type":"control_request","request_id":…,"request":{"subtype":"get_context_usage","detail":"full"}}
// stdout 回一条 control_response,`response` 里就是 Claude 桌面版右侧栏那张表(2.1.283 实测):
// `categories[{name,tokens,color,kind}]`、`totalTokens`/`maxTokens`、`autoCompactThreshold`、
// `mcpTools[{name,serverName,tokens}]`、`memoryFiles`、`skills`……外加 TUI 方格画 `gridRows`
// (十几 KB,不要)。
//
// **只在活着的进程、回合 `result` 之后问**:冷启动 `--resume` 直接问虽然 0.2 秒就回,但 MCP
// 服务器还没连上,「MCP tools」整项缺失、其余几项的归类也对不上 —— 不能拿它做按需刷新。
// 问的时机在 claude-single-run.ts(单飞收台前)与 team/session-consumer.ts(调度台每个回合末)。
import type { ContextBreakdown, ContextBreakdownKind } from "@navi/shared";

export const CONTEXT_BREAKDOWN_SUBTYPE = "get_context_usage";

/**
 * 要 `full`(真去计数)不要 `summary`(本地估算)。同一会话两种的总量对得上,但 `summary` 的分项不可信:
 * 2.1.283 实测把约 35K 的 MCP 工具说明算进了「System tools」和「Messages」(MCP 53.5K → 18.5K),
 * 中文消息也估少。代价是慢:`full` 一次 1.4–2 秒(156K 的会话也在 2 秒上下),`summary` 几毫秒;
 * 关了 stdin 再回执照样成立(实测关后 1.4 秒回执、随后 exit 0)。计数服务连不上时 CLI 自己退回估算。
 */
export const CONTEXT_BREAKDOWN_DETAIL = "full";

/** 回合末问分项最多等多久(`full` 实测 2 秒上下);等不到就照常收台、不留快照,绝不拖住结算。 */
export const CONTEXT_BREAKDOWN_TIMEOUT_MS = 5_000;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const KINDS = new Set<ContextBreakdownKind>(["used", "buffer", "free"]);

/** control_response 里的 `response` → 快照。形状认不出(CLI 改了协议)就是 null,不拼半份。 */
export function parseClaudeContextUsage(raw: unknown, at: string): ContextBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (!Array.isArray(r.categories)) return null;
  const categories = r.categories.flatMap((item: any) => {
    const tokens = count(item?.tokens);
    if (typeof item?.name !== "string" || !item.name || tokens === null) return [];
    // 没报 kind 的按占用算:预留与剩余这两份 CLI 一向标着。
    const kind: ContextBreakdownKind = KINDS.has(item.kind) ? item.kind : "used";
    return [{ name: item.name, tokens, kind }];
  });
  if (!categories.length) return null;
  const used = categories.filter((c: { kind: string }) => c.kind === "used").reduce((sum: number, c: { tokens: number }) => sum + c.tokens, 0);
  const all = categories.reduce((sum: number, c: { tokens: number }) => sum + c.tokens, 0);
  const servers = new Map<string, { tokens: number; tools: number }>();
  for (const tool of Array.isArray(r.mcpTools) ? r.mcpTools : []) {
    const tokens = count(tool?.tokens);
    if (typeof tool?.serverName !== "string" || tokens === null) continue;
    const server = servers.get(tool.serverName) ?? { tokens: 0, tools: 0 };
    servers.set(tool.serverName, { tokens: server.tokens + tokens, tools: server.tools + 1 });
  }
  const memoryFiles = (Array.isArray(r.memoryFiles) ? r.memoryFiles : []).flatMap((file: any) => {
    const tokens = count(file?.tokens);
    if (typeof file?.path !== "string" || tokens === null) return [];
    return [{ path: file.path, type: typeof file.type === "string" ? file.type : "", tokens }];
  });
  const skillTokens = count(r.skills?.tokens);
  return {
    at,
    turnStartedAt: null,
    model: typeof r.model === "string" ? r.model : null,
    total: count(r.totalTokens) ?? used,
    max: count(r.maxTokens) ?? all,
    autoCompactThreshold: r.isAutoCompactEnabled === false ? null : count(r.autoCompactThreshold),
    categories,
    mcpServers: [...servers].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.tokens - a.tokens),
    memoryFiles,
    skills: skillTokens === null ? null : {
      total: count(r.skills.totalSkills) ?? 0,
      included: count(r.skills.includedSkills) ?? 0,
      tokens: skillTokens,
    },
  };
}

/**
 * 落库那份 JSON → 快照。只认自己写下的形状(上面产出的),坏了当没有 —— 分项是锦上添花,
 * 读不出来界面照旧只画水位。
 */
export function parseStoredContextBreakdown(json: string | null | undefined): ContextBreakdown | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as ContextBreakdown;
    if (!value || typeof value.at !== "string" || !Array.isArray(value.categories) || !value.categories.length) return null;
    return {
      ...value,
      turnStartedAt: typeof value.turnStartedAt === "string" ? value.turnStartedAt : null,
      mcpServers: Array.isArray(value.mcpServers) ? value.mcpServers : [],
      memoryFiles: Array.isArray(value.memoryFiles) ? value.memoryFiles : [],
      skills: value.skills ?? null,
    };
  } catch {
    return null;
  }
}

/** 存着/收到的那份文本 → 校验过、可原样再存的文本;坏的是 null。接力导出导入两头共用,不把坏的搬过去。 */
export function storedContextBreakdownText(json: string | null | undefined): string | null {
  const parsed = parseStoredContextBreakdown(json);
  return parsed ? JSON.stringify(parsed) : null;
}
