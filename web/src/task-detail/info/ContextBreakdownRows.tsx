// 「信息」格「上下文」那一行的分项：收起时把细条按分项分色，点开在这一行下面就地列出各项占多少
// （claude 才有，见 shared/src/context-breakdown.ts）。没有分项的会话这里一样都不画，那一行照旧。
import { useCallback, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { ContextBreakdown } from "@navi/shared";
import { formatTokens } from "@navi/shared/usage";
import { InspRow } from "../../inspector/parts.tsx";
import { safeStorage } from "../../lib/safeStorage.ts";
import { useNow } from "../../lib/useNow.ts";
import { ago } from "../../acceptance/gateLine.ts";
import { breakdownRows, formatShare, mcpServerRows, usedSegments, type BreakdownRow } from "./contextBreakdownView.ts";

/** 点开过就一直开着：切任务、刷新都照旧（一台机器一份，不分任务）。 */
function useStoredOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => safeStorage.get(key) === "1");
  const toggle = useCallback(() => {
    setOpen((current) => {
      safeStorage.set(key, current ? "0" : "1");
      return !current;
    });
  }, [key]);
  return [open, toggle];
}

export const useContextBreakdownOpen = () => useStoredOpen("navi:context-breakdown-open");

/** 分段细条：`fill` 是用掉的那一截占整根多少，那一截再按分项比例切成几段，颜色跟列表里的色块一一对应。 */
export function ContextSegmentBar({ breakdown, fill }: { breakdown: ContextBreakdown; fill: number }) {
  return (
    <span className="insp-bar is-split" aria-hidden="true">
      <span className="insp-bar__used" style={{ transform: `scaleX(${Math.min(1, Math.max(0, fill))})` }}>
        {usedSegments(breakdown).map((segment) => (
          <i key={segment.key} data-ctx={segment.key} style={{ flexGrow: segment.part }} />
        ))}
      </span>
    </span>
  );
}

function Row({ row, children }: { row: BreakdownRow; children?: React.ReactNode }) {
  return (
    <>
      <i className="insp-ctx__dot" data-ctx={row.key} aria-hidden="true" />
      <span className="insp-ctx__name"><span className="insp-cut">{row.label}</span>{children}</span>
      <span className="insp-num">{formatTokens(row.tokens)}</span>
      <span className="insp-num insp-faint">{formatShare(row.share)}</span>
    </>
  );
}

/** 「MCP 工具」那一项：再点开按服务器列各占多少。 */
function McpRow({ row, breakdown }: { row: BreakdownRow; breakdown: ContextBreakdown }) {
  const [open, toggle] = useStoredOpen("navi:context-breakdown-mcp-open");
  const servers = mcpServerRows(breakdown);
  if (!servers.length) return <li className="insp-ctx__row"><Row row={row} /></li>;
  return (
    <li className="insp-ctx__group">
      <button type="button" className="insp-ctx__row is-toggle" aria-expanded={open} onClick={toggle}>
        <Row row={row}><CaretRight size={10} className="insp-ctx__chev" aria-hidden="true" /></Row>
      </button>
      {open && (
        <ul className="insp-ctx__sub">
          {servers.map((server) => (
            <li key={server.name} className="insp-ctx__row">
              <span />
              <span className="insp-cut">{server.name}</span>
              <span className="insp-num">{formatTokens(server.tokens)}</span>
              <span className="insp-num insp-faint">{formatShare(server.share)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 就地展开的分项列表：收着时高度为 0、不可聚焦，开合带过渡，下面几行顺势挪。 */
export function ContextBreakdownList({ id, breakdown, open }: { id: string; breakdown: ContextBreakdown; open: boolean }) {
  // 「几分钟前」开着才走表，收着不白白重画。
  const now = useNow(open, 30_000);
  return (
    <InspRow wide className="insp-ctx">
      <div id={id} className="insp-ctx__fold" data-open={open || undefined}>
        <div className="insp-ctx__inner" inert={!open}>
          <ul className="insp-ctx__list">
            {breakdownRows(breakdown).map((row) => row.key === "mcp-tools"
              ? <McpRow key={row.name} row={row} breakdown={breakdown} />
              : <li key={row.name} className="insp-ctx__row"><Row row={row} /></li>)}
          </ul>
          <p className="insp-ctx__stamp"><time dateTime={breakdown.at}>{ago(breakdown.at, now)}</time> · 回合结束时刷新</p>
        </div>
      </div>
    </InspRow>
  );
}
