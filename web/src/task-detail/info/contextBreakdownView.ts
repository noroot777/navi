// 上下文分项(shared ContextBreakdown)→「信息」格要画的那几样：每项的中文名与配色键、各占窗口多少、
// 收起时那根分段细条每段多宽。纯函数，组件在 ContextBreakdownRows.tsx。
import type { ContextBreakdown, ContextBreakdownCategory, ContextBreakdownMcpServer } from "@navi/shared";

/** CLI 的类别名 → 配色键 + 中文名。认不出的原样显示名字、按 kind 落到通用色，不丢。 */
const KNOWN: Record<string, { key: string; label: string }> = {
  "System prompt": { key: "system-prompt", label: "系统提示" },
  "System tools": { key: "system-tools", label: "系统工具" },
  "MCP tools": { key: "mcp-tools", label: "MCP 工具" },
  "MCP server instructions": { key: "mcp-instructions", label: "MCP 说明" },
  "Custom agents": { key: "agents", label: "自定义智能体" },
  "Memory files": { key: "memory", label: "记忆文件" },
  Skills: { key: "skills", label: "技能" },
  Messages: { key: "messages", label: "消息" },
  "Autocompact buffer": { key: "buffer", label: "压缩预留" },
  "Free space": { key: "free", label: "空闲" },
};

export interface BreakdownRow {
  name: string;
  label: string;
  /** 配色键：样式表按 `data-ctx` 上色，细条和列表里的色块是同一份。 */
  key: string;
  kind: ContextBreakdownCategory["kind"];
  tokens: number;
  /** 占整个窗口(maxTokens)的比例 0..1。 */
  share: number;
}

const fallbackKey = (kind: ContextBreakdownCategory["kind"]) => kind === "used" ? "other" : kind;

export function breakdownRows(breakdown: ContextBreakdown): BreakdownRow[] {
  return breakdown.categories.map((category) => {
    const known = KNOWN[category.name];
    return {
      name: category.name,
      label: known?.label ?? category.name,
      key: known?.key ?? fallbackKey(category.kind),
      kind: category.kind,
      tokens: category.tokens,
      share: breakdown.maxTokens > 0 ? category.tokens / breakdown.maxTokens : 0,
    };
  });
}

/**
 * 收起时那根细条：用掉的那一截按各项的比例切开。只画 `used` 的几项；预留和空闲就是没涂的底色。
 * 返回各段占「用掉那一截」的比例(加起来是 1)，那一截多长由调用方按此刻的水位定 —— 分项是回合末
 * 的快照，水位每次请求都在涨，整根条跟着水位走、只是按快照的比例分色。
 */
export function usedSegments(breakdown: ContextBreakdown): { key: string; part: number }[] {
  const used = breakdownRows(breakdown).filter((row) => row.kind === "used" && row.tokens > 0);
  const total = used.reduce((sum, row) => sum + row.tokens, 0);
  return total > 0 ? used.map((row) => ({ key: row.key, part: row.tokens / total })) : [];
}

/** 用掉的那一截占窗口多少（水位没有窗口时，细条退回按快照画）。 */
export function breakdownUsedShare(breakdown: ContextBreakdown): number {
  return breakdown.maxTokens > 0 ? Math.min(1, breakdown.totalTokens / breakdown.maxTokens) : 0;
}

/** 「26.8%」。不到 0.1% 但不是 0 的写「<0.1%」，免得一项明明占着却显示 0。 */
export function formatShare(share: number): string {
  const percent = share * 100;
  if (percent <= 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

/** MCP 工具那一项点开后按服务器列出来；只有一个服务器也列，好知道是谁。 */
export function mcpServerRows(breakdown: ContextBreakdown): (ContextBreakdownMcpServer & { share: number })[] {
  return breakdown.mcpServers.map((server) => ({
    ...server,
    share: breakdown.maxTokens > 0 ? server.tokens / breakdown.maxTokens : 0,
  }));
}
