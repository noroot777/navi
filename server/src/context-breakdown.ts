// 上下文分项(shared/src/context-breakdown.ts)在服务端的两头:从 claude 的 `get_context_usage` 回包里
// 取出来(executors/claude-control.ts 发请求、这里认回包),以及落到会话行、读回来。
//
// 回包的形状(claude 2.1.283 实测):`categories:[{name,tokens,color,kind}]`、`totalTokens`、`maxTokens`、
// `autoCompactThreshold`、`isAutoCompactEnabled`、`model`、`mcpTools:[{name,serverName,tokens,isLoaded}]`、
// `skills:{totalSkills,includedSkills,tokens,skillFrontmatter}`、`memoryFiles:[{path,type,tokens}]`,另有
// `gridRows`(TUI 方格画)、`messageBreakdown`、`apiUsage`、`slashCommands`、`agents`。只取界面用得上的几样,
// 方格画不存。这里只有纯函数(执行器那一层也要用);落库在 usage.ts 的 setSessionContextBreakdown。
import type { ContextBreakdown, ContextBreakdownCategory, ContextBreakdownMcpServer } from "@navi/shared";

const count = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
const text = (raw: unknown): string | null => typeof raw === "string" && raw.trim() ? raw : null;
const record = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const list = (raw: unknown): unknown[] => Array.isArray(raw) ? raw : [];

const KINDS = new Set<ContextBreakdownCategory["kind"]>(["used", "buffer", "free"]);

function categoriesOf(raw: unknown): ContextBreakdownCategory[] {
  const out: ContextBreakdownCategory[] = [];
  for (const item of list(raw)) {
    const entry = record(item);
    const name = text(entry?.name);
    const tokens = count(entry?.tokens);
    const kind = entry?.kind;
    if (!name || tokens === null) continue;
    // 认不出的类别照样留着、按占用算:CLI 将来多一类,界面原样显示它,不丢。
    out.push({ name, tokens, kind: KINDS.has(kind as ContextBreakdownCategory["kind"]) ? kind as ContextBreakdownCategory["kind"] : "used" });
  }
  return out;
}

function memoryFilesOf(raw: unknown): ContextBreakdown["memoryFiles"] {
  const out: ContextBreakdown["memoryFiles"] = [];
  for (const item of list(raw)) {
    const entry = record(item);
    const path = text(entry?.path);
    const tokens = count(entry?.tokens);
    if (path && tokens !== null) out.push({ path, type: text(entry?.type) ?? "", tokens });
  }
  return out;
}

function skillsOf(raw: unknown): ContextBreakdown["skills"] {
  const entry = record(raw);
  if (!entry) return null;
  const total = count(entry.total ?? entry.totalSkills);
  const included = count(entry.included ?? entry.includedSkills);
  const tokens = count(entry.tokens);
  return total === null || tokens === null ? null : { total, included: included ?? total, tokens };
}

function mcpServersOf(raw: unknown): ContextBreakdownMcpServer[] {
  const out: ContextBreakdownMcpServer[] = [];
  for (const item of list(raw)) {
    const entry = record(item);
    const name = text(entry?.name);
    const tokens = count(entry?.tokens);
    const tools = count(entry?.tools);
    if (name && tokens !== null) out.push({ name, tokens, tools: tools ?? 0 });
  }
  return out;
}

/** 逐个工具 → 按服务器合计,大的在前。 */
function mcpServersFromTools(raw: unknown): ContextBreakdownMcpServer[] {
  const byServer = new Map<string, ContextBreakdownMcpServer>();
  for (const item of list(raw)) {
    const entry = record(item);
    const server = text(entry?.serverName);
    const tokens = count(entry?.tokens);
    if (!server || tokens === null) continue;
    const current = byServer.get(server) ?? { name: server, tokens: 0, tools: 0 };
    current.tokens += tokens;
    current.tools += 1;
    byServer.set(server, current);
  }
  return [...byServer.values()].sort((a, b) => b.tokens - a.tokens);
}

/**
 * `get_context_usage` 的回包 → 分项。少了分项表或窗口就当没取到(null),不拿半份冒充;
 * `turnStartedAt` 由落库的那一层填(执行器不知道回合身份)。
 */
export function contextBreakdownFromClaude(response: unknown, at: string): ContextBreakdown | null {
  const body = record(response);
  if (!body) return null;
  const categories = categoriesOf(body.categories);
  const maxTokens = count(body.maxTokens);
  if (!categories.length || !maxTokens) return null;
  const used = categories.filter((category) => category.kind === "used").reduce((sum, category) => sum + category.tokens, 0);
  return {
    at,
    turnStartedAt: null,
    model: text(body.model),
    totalTokens: count(body.totalTokens) ?? used,
    maxTokens,
    autoCompactThreshold: body.isAutoCompactEnabled === false ? null : count(body.autoCompactThreshold),
    categories,
    mcpServers: mcpServersFromTools(body.mcpTools),
    skills: skillsOf(body.skills),
    memoryFiles: memoryFilesOf(body.memoryFiles),
  };
}

/** 会话行上存的那份 → 分项。坏了/没有就是 null,界面按「没有分项」画,不把垃圾递出去。 */
export function parseStoredContextBreakdown(raw: string | null | undefined): ContextBreakdown | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const body = record(JSON.parse(raw));
    const at = text(body?.at);
    const categories = categoriesOf(body?.categories);
    const maxTokens = count(body?.maxTokens);
    if (!body || !at || !categories.length || !maxTokens) return null;
    return {
      at,
      turnStartedAt: text(body.turnStartedAt),
      model: text(body.model),
      totalTokens: count(body.totalTokens) ?? 0,
      maxTokens,
      autoCompactThreshold: count(body.autoCompactThreshold),
      categories,
      mcpServers: mcpServersOf(body.mcpServers),
      skills: skillsOf(body.skills),
      memoryFiles: memoryFilesOf(body.memoryFiles),
    };
  } catch {
    return null;
  }
}
