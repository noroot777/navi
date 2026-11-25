// 「为了重启而停服务」的那道关口：先冻结接活，再在冻结状态下给出影响快照，停服务的一方凭这份快照停。
//
// 只有 `GET /restart-impact` 的时候，查完到真正停下之间服务照常接新任务、起新终端、拉起新 agent，
// 这些都不在用户刚看过的名单里，照样被打断（mac 的「允许其他设备访问」、Windows 壳的同一个开关、
// `npm run restart` 都是这样）。客户端「确认后再评估一次」只能把窗口收窄，堵不死：再评估和停下之间
// 那一下只有服务端能关。
//
// 冻结用的是 mac 换运行时那份许可（runtime-handover-state.ts，kind=restart），不另造一套：
// 新回合认领、团队调度台投递、新终端、聊天执行、预览试跑都在登记自己之前等它（`waitServiceThaw`
// 与 turn-lock.ts 的认领）。所以拿到冻结的那一刻，往后还能变成「会被打断」的只剩**已经占住回合锁
// 还没跑起来的**那几个 —— 快照先给它们一小会儿落定，落不定的照实列进 interrupted。
//
// 冻结有自己的期限（持有者崩了也会自己解冻），持有者在停服务之前续一次期（同时核对凭据还在），
// 取消就放掉；被挡住的入口照常接着走，不算失败。
import type { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { liveLockToken } from "./singleton.js";
import { secretsEqual } from "./openai-converter/common.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { heldTurns } from "./turn-lock.js";
import { shutdownResources } from "./shutdown-resources.js";
import type { RestartImpact } from "./reattach.js";
import {
  currentServiceFreeze, onServiceFreezeChange, releaseServiceFreeze, renewServiceFreeze, reserveServiceFreeze, serviceFreezeMatches,
} from "./runtime-handover-state.js";

/** 协议号：`/restart-impact` 与本端点的每个答复都带着它，调用方凭它分辨「这一版服务认这道关口」。 */
export const RESTART_FREEZE_PROTOCOL = 1;

const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 120_000;
/** 占着回合锁、还没跑成可接管进程的那几个，最多等它们这么久。 */
const SETTLE_MS = 4_000;
const SETTLE_POLL_MS = 200;

const HELD_ROLE_REASON: Record<string, string> = {
  "accept-hold": "所属团队正在验收，重启会打断这一步",
  scm: "正在操作它的工作区，重启会打断这一步",
  "lead-wake": "调度台正在被唤醒，重启会打断这一步",
};
const STARTING_REASON = "正在起跑，还没交给重启后接得回的进程";

export type RestartFreezeSnapshot = RestartImpact & { shutdown: Awaited<ReturnType<typeof shutdownResources>> };

function ttlOf(value: unknown): number {
  const ms = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.round(ms)));
}

/** 占着回合锁、却不在 survives / resumes 里的任务：它们是冻结那一刻还在路上的。 */
function unsettledTurns(impact: RestartImpact) {
  const settled = new Set([...impact.survives, ...impact.resumes].map((item) => item.id));
  return heldTurns().filter((turn) => !settled.has(turn.taskId));
}

/**
 * 冻结之下的影响快照。`assess` 只给回归换成假的；缺省是 `restartImpact`。
 *
 * 冻结之后新的回合认领一律被挡，所以占着回合锁的集合只会缩小：给它们 `SETTLE_MS` 落定（跑成可接管的
 * 进程、或者自己还了锁），到点还在路上的照实列进 interrupted —— 名单是上界，停下之前不会再多。
 */
export async function frozenRestartSnapshot(assess?: () => Promise<RestartImpact>): Promise<RestartFreezeSnapshot> {
  const measure = assess ?? (async () => (await import("./reattach.js")).restartImpact());
  const until = Date.now() + SETTLE_MS;
  let impact = await measure();
  while (unsettledTurns(impact).length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    impact = await measure();
  }
  const pending = unsettledTurns(impact);
  if (pending.length) {
    const titles = new Map((await db.select({ id: tasks.id, title: tasks.title }).from(tasks)
      .where(inArray(tasks.id, pending.map((turn) => turn.taskId)))).map((row) => [row.id, row.title || row.id]));
    for (const turn of pending) {
      const reason = HELD_ROLE_REASON[turn.role] ?? STARTING_REASON;
      const listed = impact.interrupted.find((item) => item.id === turn.taskId);
      // 还在起跑的那几个此刻多半被判成「没有 agent_pid」，那不是用户该看到的原因。
      if (listed) listed.reason = reason;
      else impact.interrupted.push({ id: turn.taskId, title: titles.get(turn.taskId) ?? turn.taskId, reason });
    }
  }
  return { ...impact, shutdown: await shutdownResources() };
}

export type RestartFreezeAcquired = {
  lease: string; instance: string; pid: number; revision: number; expiresInMs: number; impact: RestartFreezeSnapshot;
};

/** 冻结并给出快照；另一处正冻着就是 `{ busy }`。快照算挂了就放掉，不留一份没人认的冻结。 */
export async function acquireRestartFreeze(ttlMs?: unknown, assess?: () => Promise<RestartImpact>): Promise<RestartFreezeAcquired | { busy: string }> {
  const ttl = ttlOf(ttlMs);
  const held = currentServiceFreeze();
  if (held) return { busy: held.kind === "handover" ? "正在切换新版服务" : "另一处正在准备重启服务" };
  const reserved = reserveServiceFreeze("restart", ttl)!;
  try {
    const impact = await frozenRestartSnapshot(assess);
    // 快照花掉的那几秒不算持有者的：给出去的时候期限从头算。
    const deadline = renewServiceFreeze(reserved.token, ttl);
    if (deadline === null) return { busy: "冻结在算快照时已失效" };
    return { lease: reserved.token, instance: INSTANCE_ID, pid: process.pid, revision: reserved.revision,
      expiresInMs: Math.max(0, deadline - Date.now()), impact };
  } catch (error) {
    releaseServiceFreeze(reserved.token);
    throw error;
  }
}

/** 给界面（`/health` 与 `service.freeze` 事件）的那一份：只说哪一种、冻到什么时候，不带凭据。 */
export function serviceFreezePublic(): { kind: "handover" | "restart"; until: string } | null {
  const freeze = currentServiceFreeze();
  return freeze ? { kind: freeze.kind, until: new Date(freeze.deadline).toISOString() } : null;
}

onServiceFreezeChange(() => bus.publish({ type: "service.freeze", freeze: serviceFreezePublic() }));

type FreezeBody = { ttlMs?: unknown; renew?: unknown; release?: unknown };

export function mountRestartFreezeRoutes(api: Hono) {
  // 凭证只认单实例锁里那串 token（同 `/restart-impact` 的匿名档）：冻结整份服务是宿主机运维者的事，
  // 登录用户不行。实例号的核对在 instance-binding.ts 那一层：带着别的实例号来的请求到不了这里。
  api.post("/restart-freeze", async (c) => {
    const expected = liveLockToken();
    const given = requestHeader(c, NAVI_HEADERS.hostToken)?.trim() ?? "";
    if (!expected || !secretsEqual(given, expected)) {
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, error: "没有冻结这份服务的权限" }, 403);
    }
    const body = await c.req.json<FreezeBody>().catch(() => ({} as FreezeBody));
    if (typeof body.release === "string") {
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, released: releaseServiceFreeze(body.release) });
    }
    if (typeof body.renew === "string") {
      const deadline = serviceFreezeMatches(body.renew) && currentServiceFreeze()?.kind === "restart"
        ? renewServiceFreeze(body.renew, ttlOf(body.ttlMs)) : null;
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, valid: deadline !== null,
        ...(deadline !== null ? { expiresInMs: Math.max(0, deadline - Date.now()) } : {}) });
    }
    try {
      const result = await acquireRestartFreeze(body.ttlMs);
      if ("busy" in result) return c.json({ protocol: RESTART_FREEZE_PROTOCOL, error: result.busy }, 409);
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, ...result });
    } catch (error) {
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, error: `影响快照没算出来：${error instanceof Error ? error.message : String(error)}` }, 500);
    }
  });
}
