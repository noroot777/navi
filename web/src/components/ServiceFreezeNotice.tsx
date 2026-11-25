import { useEffect, useState } from "react";
import type { ServerEvent } from "@navi/shared";
import { subscribeConnection, subscribeEvents } from "../lib/events.ts";

type Freeze = Extract<ServerEvent, { type: "service.freeze" }>["freeze"];

/**
 * 服务冻着的时候（准备重启 / 换新版服务，server/src/restart-freeze.ts）新回合、新终端都在等它解冻：
 * 点了「运行」却迟迟不动，没有这一句就只像卡住了。开页时从 `/api/health` 取一次，之后跟
 * `service.freeze` 事件；断线重连再取一次（解冻那一刻可能正好断着）。到了期限自己收起，不等事件。
 */
export function ServiceFreezeNotice() {
  const [freeze, setFreeze] = useState<Freeze>(null);

  useEffect(() => {
    let alive = true;
    const refetch = () => {
      void fetch("/api/health", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((health: { freeze?: Freeze } | null) => { if (alive && health) setFreeze(health.freeze ?? null); })
        .catch(() => {});
    };
    const offEvents = subscribeEvents((event) => { if (event.type === "service.freeze") setFreeze(event.freeze); });
    const offConnection = subscribeConnection((connected) => { if (connected) refetch(); });
    return () => { alive = false; offEvents(); offConnection(); };
  }, []);

  useEffect(() => {
    if (!freeze) return;
    const left = Date.parse(freeze.until) - Date.now();
    if (!(left > 0)) { setFreeze(null); return; }
    const timer = setTimeout(() => setFreeze(null), left);
    return () => clearTimeout(timer);
  }, [freeze]);

  if (!freeze) return null;
  return (
    <div className="service-freeze-notice" role="status">
      <i aria-hidden="true" />
      {freeze.kind === "restart" ? "服务正在准备重启，新的任务和回合稍后开始" : "正在切换新版服务，新的任务和回合稍后开始"}
    </div>
  );
}
