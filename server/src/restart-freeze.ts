// 「为了重启而停服务」的那道关口：先冻结接活，再在冻结状态下给出影响快照，停服务的一方凭这份快照停。
//
// 只有 `GET /restart-impact` 的时候，查完到真正停下之间服务照常接新任务、起新终端、拉起新 agent，
// 这些都不在用户刚看过的名单里，照样被打断（mac 的「允许其他设备访问」、Windows 壳的同一个开关、
// `npm run restart` 都是这样）。客户端「确认后再评估一次」只能把窗口收窄，堵不死：再评估和停下之间
// 那一下只有服务端能关。
//
// 冻结用的是 mac 换运行时那份许可（runtime-handover-state.ts，kind=restart），不另造一套：
// 新回合认领、团队开台与投递、新终端、聊天执行、AI 协助、预览试跑都在登记自己之前等它（`waitServiceThaw`
// 与 turn-lock.ts 的认领）。所以拿到冻结的那一刻，往后还能变成「会被打断」的只剩**已经占住回合锁
// 还没跑起来的**那几个 —— 快照先给它们一小会儿落定，落不定的照实列进 interrupted。
//
// 有一样东西服务端冻不住：已经在跑的 agent 自己在回合中途拉起 navi MCP（mcpDisrupted 会因此变多）。
// 所以续期那一下把**此刻**的名单一并交回去，调用方拿它跟用户同意过的那份比，多出来就不停 —— 名单在冻结
// 期间不会悄悄变多，变多了停服务的一方看得见。
//
// 最后一次续期核对到真正停下之间，已经在跑的 agent 仍可能新发起 Navi MCP 调用 —— 外部进程「之后不会变」这件事
// 证明不了，所以不在冻结这里加核对（用户 2026-11-26 选定），而是让那次调用扛得住停机：
//  · 停止信号一到就关门（runtime-handover-gate.ts）：新来的请求答「未执行」，MCP 退避重试到新服务起来
//    （mcp/src/runtime.ts，窗口盖得住一次正常重启）；
//  · 已经进门的处理完、答复写出去才退（singleton.ts 的 drainBeforeExit，有上限，超了如实写进退出日志）；
//  · MCP 每次调用带请求号，服务端按它记账（request-receipts.ts）：处理中被截断、答复没送出去的，带同一个
//    请求号重试到新服务上，答过的回放、交卷执行到一半的认回那一笔（同一事务里记下的答复 / 按请求号交回同一批
//    哨兵结果）、认不出的如实答「不确定」—— 不丢，也不做两遍。MCP 重发之前核对对面还是同一本账。
// Windows 停服务是整树结束、没有排空那一步，靠的是第三条；升级之前起的 MCP 子进程不带请求号，靠的是前两条。
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
import { SHUTDOWN_DRAIN_MS, shutdownResources } from "./shutdown-resources.js";
import type { RestartImpact } from "./reattach.js";
import {
  currentServiceFreeze, onServiceFreezeChange, releaseServiceFreeze, renewServiceFreeze, reserveServiceFreeze, serviceFreezeMatches,
  serviceShuttingDown,
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
 * 冻结之后新的回合认领一律被挡，所以占着回合锁的集合只会缩小：给它们 `settleMs` 落定（跑成可接管的
 * 进程、或者自己还了锁），到点还在路上的照实列进 interrupted。续期时再算一遍用 0（不等，就要此刻的）。
 */
export async function frozenRestartSnapshot(assess?: () => Promise<RestartImpact>, settleMs = SETTLE_MS): Promise<RestartFreezeSnapshot> {
  const measure = assess ?? (async () => (await import("./reattach.js")).restartImpact());
  const until = Date.now() + settleMs;
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
  const reserved = reserveServiceFreeze("restart", ttl);
  if (!reserved) return { busy: serviceShuttingDown() ? "服务正在停止" : "另一处正在准备重启服务" };
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

/**
 * 给界面（`/health` 与 `service.freeze` 事件）的那一份：只说哪一种、冻到什么时候，不带凭据。
 * 另给剩余毫秒：开着页面的可能是另一台设备（允许其他设备访问），两边墙钟对不齐，页面按收到时的本机时钟倒数。
 */
export function serviceFreezePublic(): { kind: "handover" | "restart"; until: string; remainingMs: number } | null {
  const freeze = currentServiceFreeze();
  // 正在停止（没有许可、也没有期限）：按排空最多要的那几秒报，页面上照样看得出「新的活稍后开始」。
  // 兑现了的换运行时许可（runtime-handover-state.ts 的 commitRuntimeHandover）没有期限、马上就退：同样按排空那几秒报。
  const held = freeze && Number.isFinite(freeze.deadline) ? freeze.deadline : freeze ? Date.now() + SHUTDOWN_DRAIN_MS : null;
  const deadline = held ?? (serviceShuttingDown() ? Date.now() + SHUTDOWN_DRAIN_MS : null);
  return deadline === null ? null
    : { kind: freeze?.kind ?? "restart", until: new Date(deadline).toISOString(), remainingMs: Math.max(0, deadline - Date.now()) };
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
      if (deadline === null) return c.json({ protocol: RESTART_FREEZE_PROTOCOL, valid: false });
      // 此刻的名单（见顶部）：调用方拿它跟同意过的那份比。算挂了就不给，调用方按「核对不了」不停。
      const impact = await frozenRestartSnapshot(undefined, 0).catch(() => null);
      return c.json({ protocol: RESTART_FREEZE_PROTOCOL, valid: serviceFreezeMatches(body.renew),
        expiresInMs: Math.max(0, deadline - Date.now()), ...(impact ? { impact } : {}) });
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
