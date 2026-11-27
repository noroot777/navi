import type { ContextBreakdown, ContextBreakdownCategory } from "@navi/shared";

/**
 * 上下文分项(shared ContextBreakdown)在界面上的那几样:中文名、色块、占比。分类名是 CLI 给的英文,
 * 按原样存;这里认得的换成中文,认不出的原样显示 —— 别丢。色块按名字定,每一回合拿来比的时候不换色。
 */
const CATEGORIES: Record<string, { label: string; tone: string }> = {
  "System prompt": { label: "系统提示词", tone: "system" },
  "System tools": { label: "系统工具", tone: "tools" },
  "MCP tools": { label: "MCP 工具", tone: "mcp" },
  "MCP server instructions": { label: "MCP 服务说明", tone: "mcp-note" },
  "Custom agents": { label: "自定义智能体", tone: "agents" },
  "Memory files": { label: "记忆文件", tone: "memory" },
  "Skills": { label: "技能", tone: "skills" },
  "Messages": { label: "消息", tone: "messages" },
  "Autocompact buffer": { label: "自动压缩预留", tone: "buffer" },
  "Free space": { label: "剩余空间", tone: "free" },
};

export function categoryLabel(name: string): string {
  return CATEGORIES[name]?.label ?? name;
}

/** 色块的 class 后缀。认不出的分类按它的归类给一档中性色。 */
export function categoryTone(category: ContextBreakdownCategory): string {
  const known = CATEGORIES[category.name]?.tone;
  if (known) return known;
  return category.kind === "used" ? "other" : category.kind;
}

/** 占比:分母是 CLI 认的整个窗口(各份之和),跟它自己那张表同一个口径。 */
export function categoryShare(tokens: number, breakdown: ContextBreakdown): string {
  if (breakdown.max <= 0) return "";
  const pct = (tokens / breakdown.max) * 100;
  if (tokens === 0) return "0%";
  return pct >= 1 ? `${Math.round(pct)}%` : "<1%";
}

/** 「3 分钟前」。一小时以上按小时,一天以上按天 —— 分项是回合末才刷新的,读着要知道有多旧。 */
export function updatedAgo(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (60 * 24))} 天前`;
}

export function hasBreakdown(breakdown: ContextBreakdown | null | undefined): breakdown is ContextBreakdown {
  return !!breakdown && breakdown.categories.length > 0;
}
