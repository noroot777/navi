import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { ContextBreakdown, ContextBreakdownCategory } from "@navi/shared";
import { formatTokens, formatTokensExact } from "@navi/shared/usage";
import { useNow } from "../lib/useNow.ts";
import { categoryLabel, categoryShare, categoryTone, updatedAgo } from "./contextBreakdown.ts";

/**
 * 上下文分项:一根按份切开的横条,下面一份一行(色块、名称、token、占比)。「MCP 工具」「记忆文件」
 * 点开是按服务 / 按文件的明细。数是回合末向 CLI 问来的,跟上面的水位不同时刻,所以末尾说一句
 * 它有多旧。没有分项的会话(codex、老会话、没取到)根本不渲染这一块。
 */
export function ContextBreakdownView({ breakdown }: { breakdown: ContextBreakdown }) {
  const now = useNow(true, 30_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="ctx-breakdown">
      <div className="ctx-breakdown-bar" aria-hidden="true">
        {breakdown.categories.filter((c) => c.tokens > 0).map((c) => (
          <span key={c.name} className={`is-${categoryTone(c)}`} style={{ flexGrow: c.tokens }} />
        ))}
      </div>
      <ul>
        {breakdown.categories.map((category) => {
          const details = detailsOf(category, breakdown);
          const expanded = open === category.name && details.length > 0;
          const label = categoryLabel(category.name);
          const head = (
            <>
              <i className={`is-${categoryTone(category)}`} aria-hidden="true" />
              {label}
              {details.length > 0 && <CaretDown size={10} weight="bold" aria-hidden="true" />}
            </>
          );
          return (
            <li key={category.name}>
              <div className="ctx-breakdown-row" aria-label={`${label} ${formatTokensExact(category.tokens)} token`}>
                {details.length > 0
                  ? (
                    <button
                      type="button"
                      className={`ctx-breakdown-name${expanded ? " is-open" : ""}`}
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : category.name)}
                    >
                      {head}
                    </button>
                  )
                  : <span className="ctx-breakdown-name">{head}</span>}
                <span>{formatTokens(category.tokens)}</span>
                <span>{categoryShare(category.tokens, breakdown)}</span>
              </div>
              {expanded && details.map((detail) => (
                <div key={detail.key} className="ctx-breakdown-row is-sub" aria-label={`${detail.label} ${formatTokensExact(detail.tokens)} token`}>
                  <span className="ctx-breakdown-name">{detail.label}</span>
                  <span>{formatTokens(detail.tokens)}</span>
                  <span>{categoryShare(detail.tokens, breakdown)}</span>
                </div>
              ))}
            </li>
          );
        })}
      </ul>
      <p className="ctx-breakdown-at">{updatedAgo(breakdown.at, now)}更新，回合结束时刷新</p>
    </div>
  );
}

function detailsOf(category: ContextBreakdownCategory, breakdown: ContextBreakdown): { key: string; label: string; tokens: number }[] {
  if (category.name === "MCP tools") {
    return breakdown.mcpServers.map((server) => ({ key: server.name, label: server.name, tokens: server.tokens }));
  }
  if (category.name === "Memory files") {
    return breakdown.memoryFiles.map((file) => ({ key: file.path, label: shortPath(file.path), tokens: file.tokens }));
  }
  return [];
}

/** 记忆文件只留最后两段(`.claude/CLAUDE.md`),整条路径在面板这么窄的地方读不下。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}
