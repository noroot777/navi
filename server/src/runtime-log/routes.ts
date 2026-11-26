// 运行日志的接口：页面报事件、设置页看结论、导出给别人分析。
//
// 报事件对任何已登录的页面开放（内容在 sanitizeWebEvent 里按白名单收，报不进别的东西）；
// 看结论和导出只给本机自用或实例管理员 —— 日志里没有任务内容，但它是整台实例的运行状况，
// 不是某个人的。
import type { Hono } from "hono";
import { sanitizeWebEvent } from "@navi/shared/runtime-log";
import { instanceAdminOnly } from "../auth/context.js";
import { analyzeRuntimeLog } from "./analyze.js";
import { digestPageId, webCodeSymbols } from "./code-symbols.js";
import { runtimeLog, runtimeLogDir } from "./journal.js";
import { buildRuntimeLogBundle, loadOwnRuntimeLog } from "./load.js";

const MAX_EVENTS_PER_POST = 20;

const DAY = 86_400_000;

function sinceDays(raw: string | undefined, fallback: number): number {
  const days = Number(raw);
  return Date.now() - (Number.isFinite(days) && days > 0 ? Math.min(days, 60) : fallback) * DAY;
}

export function mountRuntimeLogRoutes(api: Hono): void {
  api.post("/runtime-log/events", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null;
    const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS_PER_POST) : [];
    let kept = 0;
    for (const raw of events) {
      const event = sanitizeWebEvent(raw, { symbols: webCodeSymbols, digest: digestPageId });
      if (!event) continue;
      const { ev, ago, ...fields } = event;
      runtimeLog(String(ev), fields, "web", typeof ago === "number" ? ago : 0);
      kept += 1;
    }
    return c.json({ kept });
  });

  api.get("/runtime-log/report", async (c) => {
    const denied = await instanceAdminOnly(c, "运行日志");
    if (denied) return c.json(denied.body, denied.status);
    const { records, exits } = loadOwnRuntimeLog(sinceDays(c.req.query("days"), 7));
    return c.json({ dir: runtimeLogDir(), report: analyzeRuntimeLog(records, exits) });
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
