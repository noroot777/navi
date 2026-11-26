// 运行日志的接口：页面报事件、设置页看结论、导出给别人分析。
//
// 报事件对任何已登录的页面开放（内容在 sanitizeWebEvent 里按白名单收，报不进别的东西）；
// 看结论和导出只给本机自用或实例管理员 —— 日志里没有任务内容，但它是整台实例的运行状况，
// 不是某个人的。
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Hono } from "hono";
import { sanitizeWebEvent } from "@navi/shared/runtime-log";
import { CODE_DIR } from "../paths.js";
import { instanceAdminOnly } from "../auth/context.js";
import { analyzeRuntimeLog } from "./analyze.js";
import { runtimeLog, runtimeLogDir } from "./journal.js";
import { buildRuntimeLogBundle, loadOwnRuntimeLog } from "./load.js";

const MAX_EVENTS_PER_POST = 20;

/**
 * 页面栈帧里的位置是不是真有这个代码文件：构建产物（web/dist 下的 assets/…）或开发时 vite 给的源码路径
 * （web 下的 src/…）。只认得磁盘上存在的，页面报什么都不能把别的字符串带进日志。查过的记住，免得反复 stat。
 */
const codeFiles = new Map<string, boolean>();
function isCodeFile(rel: string): boolean {
  const known = codeFiles.get(rel);
  if (known !== undefined) return known;
  const web = join(CODE_DIR, "web");
  const exists = [join(web, "dist", rel), join(web, rel)].some((file) => {
    const target = normalize(file);
    return target.startsWith(web + sep) && existsSync(target);
  });
  if (codeFiles.size < 2000) codeFiles.set(rel, exists);
  return exists;
}
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
      const event = sanitizeWebEvent(raw, isCodeFile);
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
