// 运行日志的接口：页面报事件、设置页看结论、导出给别人分析。
//
// 报事件对任何已登录的页面开放（内容在 sanitizeWebEvent 里按白名单收，报不进别的东西）；
// 看结论和导出只给本机自用或实例管理员 —— 日志里没有任务内容，但它是整台实例的运行状况，
// 不是某个人的。
import type { Hono } from "hono";
import { WEB_EVENTS_PER_POST, WEB_STATE_EVENTS, sanitizeWebEvent, type WebRuntimeEvent } from "@navi/shared/runtime-log";
import { instanceAdminOnly } from "../auth/context.js";
import { analyzeRuntimeLog } from "./analyze.js";
import { digestPageId, webCodeLocations } from "./code-symbols.js";
import { runtimeLog, runtimeLogDir } from "./journal.js";
import { buildRuntimeLogBundle, loadOwnRuntimeLog } from "./load.js";

/** 一次请求里最多看这么多条（老页面不分批）：先全认一遍是什么事件，再决定收哪些。 */
const MAX_EVENTS_EXAMINED = 200;

const DAY = 86_400_000;

function sinceDays(raw: string | undefined, fallback: number): number {
  const days = Number(raw);
  return Date.now() - (Number.isFinite(days) && days > 0 ? Math.min(days, 60) : fallback) * DAY;
}

export function mountRuntimeLogRoutes(api: Hono): void {
  api.post("/runtime-log/events", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null;
    const raws = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_EXAMINED) : [];
    const events: Array<NonNullable<ReturnType<typeof sanitizeWebEvent>>> = [];
    for (const raw of raws) {
      // 一条收不了只丢这一条：同一批里还可能有整页崩溃这种状态变化。
      try {
        const event = sanitizeWebEvent(raw, { locations: webCodeLocations, digest: digestPageId });
        if (event) events.push(event);
      } catch {
        // 不收
      }
    }
    // 超过一批的上限：状态（崩溃、重载、载入）先收，详情后收；没收的按事件记个数，不悄悄截掉。
    const isState = (event: (typeof events)[number]) => WEB_STATE_EVENTS.includes(event.ev as WebRuntimeEvent);
    const ordered = [...events.filter(isState), ...events.filter((event) => !isState(event))];
    const dropped = new Map<string, number>();
    for (const event of ordered.slice(WEB_EVENTS_PER_POST)) dropped.set(String(event.ev), (dropped.get(String(event.ev)) ?? 0) + 1);
    for (const event of ordered.slice(0, WEB_EVENTS_PER_POST)) {
      const { ev, ago, ...fields } = event;
      runtimeLog(String(ev), fields, "web", typeof ago === "number" ? ago : 0);
    }
    for (const [ev, count] of dropped) runtimeLog("log.dropped", { of: ev, count }, "web");
    return c.json({ kept: Math.min(ordered.length, WEB_EVENTS_PER_POST), dropped: ordered.length - Math.min(ordered.length, WEB_EVENTS_PER_POST) });
  });

  api.get("/runtime-log/report", async (c) => {
    const denied = await instanceAdminOnly(c, "运行日志");
    if (denied) return c.json(denied.body, denied.status);
    const since = sinceDays(c.req.query("days"), 7);
    const { records, exits } = loadOwnRuntimeLog(since);
    return c.json({ dir: runtimeLogDir(), report: analyzeRuntimeLog(records, exits, since) });
  });

  api.get("/runtime-log/export", async (c) => {
    const denied = await instanceAdminOnly(c, "运行日志");
    if (denied) return c.json(denied.body, denied.status);
    const bundle = buildRuntimeLogBundle(sinceDays(c.req.query("days"), 14));
    const name = `navi-runtime-log-${bundle.exportedAt.slice(0, 10)}.json`;
    return c.body(JSON.stringify(bundle), 200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
    });
  });
}
