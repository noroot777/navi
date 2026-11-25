// 重启前冻结（server/src/restart-freeze.ts + runtime-handover-state.ts）：
//   ① 认这道关口的服务在 /restart-impact 里报协议号；没有宿主机凭证冻不了
//   ② 冻结之后，起跑入口（回合认领、新终端、等解冻的入口）全都在等，影响名单不再变多；另一处冻不了
//   ③ 冻结之下的快照：还占着回合锁、没跑成可接管进程的那几个照实列进 interrupted；落定了的不列
//   ④ 持有者放掉（用户取消）：被挡住的入口照常接着走，拿到的是真的回合，不是失败
//   ⑤ 持有者不续也不放：到期自己解冻，等着的入口照样接着走；过期的凭据续不上
//   ⑥ 页面看得出来：/health 带 freeze，冻结开始、解冻都推 service.freeze
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@navi/shared";

const stage = realpathSync(mkdtempSync(join(tmpdir(), "navi-restart-freeze-")));
mkdirSync(join(stage, "home"));
process.env.HOME = join(stage, "home");
process.env.NAVI_DATA_DIR = stage;
process.env.NAVI_DB = join(stage, "test.db");
process.env.NAVI_RUNS_DIR = join(stage, "runs");
// 跟真起服务同一个顺序：先拿单实例锁（宿主机凭证就是锁里那串 token），再开库。
const { acquireDbSingletonLock, liveLockToken } = await import("../src/singleton.js");
const lock = acquireDbSingletonLock({ port: null });
assert.ok(lock, "临时库上应该拿得到单实例锁");
const { ensureSchema, db } = await import("../src/db/index.js");
await ensureSchema();
const { removeTmpStage } = await import("./tmp-db.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { api } = await import("../src/routes.js");
const { bus } = await import("../src/bus.js");
const { INSTANCE_ID } = await import("../src/instance-binding.js");
const { claimIdleWorkspaceTurns, claimOwnTurn, claimOwnTurnWhenReady, releaseTurn, turnBusyText } = await import("../src/runs.js");
const { tryClaimOwnTurn } = await import("../src/turn-lock.js");
const { claimLaunchTurn } = await import("../src/launch-capacity.js");
const { restartImpact } = await import("../src/reattach.js");
const { acquireRestartFreeze } = await import("../src/restart-freeze.js");
const { reserveServiceFreeze, serviceFrozen, ServiceFrozenError, waitServiceThaw } = await import("../src/runtime-handover-state.js");
const { terminalSessions } = await import("../src/terminal.js");
const { eq } = await import("drizzle-orm");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = new Date().toISOString();
await db.insert(projects).values({ id: "p", name: "p", repoPath: stage, createdAt: at });
for (const id of ["late", "starting", "settling", "expiry"]) {
  await db.insert(tasks).values({ id, projectId: "p", title: `任务 ${id}`, body: "", status: "paused", createdAt: at, updatedAt: at });
}

/** 一个 promise 此刻落定了没有（不等它）。 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await sleep(0);
  return done;
}

const events: ServerEvent[] = [];
const offBus = bus.subscribe((event) => { if (event.type === "service.freeze") events.push(event); });
const token = liveLockToken()!;
const freeze = (body: unknown, headers: Record<string, string> = { "x-navi-host-token": token }) => api.request("/restart-freeze", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const health = async () => (await (await api.request("/health")).json()) as { freeze: { kind: string; until: string } | null };

try {
  // ── ① 协议号与凭证 ───────────────────────────────────────────────────────────
  {
    const impact = await (await api.request("/restart-impact")).json() as { restartFreeze?: number };
    assert.equal(impact.restartFreeze, 1, "认这道关口的服务要在判据里报协议号，调用方凭它决定走不走冻结");
    const stranger = await freeze({}, { "x-navi-host-token": "not-the-token" });
    assert.equal(stranger.status, 403);
    assert.equal((await stranger.json() as { protocol?: number }).protocol, 1, "拒绝也带协议号：调用方要分得清「不认」和「不让」");
    assert.equal(serviceFrozen(), false, "没凭证就不该冻上");
    console.log("✓ /restart-impact 报协议号；没有宿主机凭证冻不了");
  }

  // ── ②④⑥ 冻结 → 入口全在等、名单不变多 → 放掉之后照常接着走 ─────────────────────
  {
    const response = await freeze({ ttlMs: 30_000 });
    assert.equal(response.status, 200);
    const frozen = await response.json() as {
      lease: string; instance: string; pid: number; revision: number; expiresInMs: number;
      impact: { interrupted: { id: string }[]; mcpDisrupted: unknown[]; shutdown: { resources: unknown[] } };
    };
    assert.equal(frozen.instance, INSTANCE_ID, "快照带实例号：调用方认它是不是刚认过的那一份");
    assert.equal(frozen.pid, process.pid);
    assert.ok(frozen.revision >= 1 && frozen.expiresInMs > 25_000);
    assert.deepEqual(frozen.impact.interrupted, []);
    assert.ok(Array.isArray(frozen.impact.shutdown.resources), "随服务一起死的终端、聊天执行也在快照里");
    assert.equal((await health()).freeze?.kind, "restart", "页面开着时从 /health 看得出服务冻着");
    assert.equal(events.at(-1)?.type === "service.freeze" && events.at(-1)?.freeze?.kind, "restart", "冻结一开始就推事件");

    const busy = await freeze({});
    assert.equal(busy.status, 409);
    assert.match((await busy.json() as { error: string }).error, /另一处正在准备重启/);

    // 起跑入口：认领回合（照 scheduler 的形状：占到锁再把任务写成排队）、并发名额、新终端、等解冻的入口。
    assert.equal(tryClaimOwnTurn("late").kind, "frozen");
    assert.match(turnBusyText("late", "运行"), /服务正在准备重启，完成后再运行/, "被挡的操作对人说清楚为什么");
    assert.throws(() => claimIdleWorkspaceTurns(["late"]), (error) => error instanceof ServiceFrozenError && /服务正在准备重启/.test(error.message));
    const launch = claimOwnTurnWhenReady("late").then(async (owner) => {
      await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, "late"));
      return owner;
    });
    const seat = claimLaunchTurn("settling", null);
    const thaw = waitServiceThaw();
    const terminal = terminalSessions.createAsync("p", stage, {});
    await sleep(300);
    assert.equal(await settled(launch), false, "冻着的时候回合认领在等");
    assert.equal(await settled(seat), false, "并发名额也在等");
    assert.equal(await settled(thaw), false);
    assert.equal(await settled(terminal), false, "新终端在等");
    assert.deepEqual(terminalSessions.listForProject("p"), []);
    const now = await restartImpact();
    assert.deepEqual(now.interrupted, [], "冻结之后影响名单不再变多");

    const renewed = await freeze({ renew: frozen.lease });
    assert.equal((await renewed.json() as { valid: boolean }).valid, true, "持有者续期：冻结还在");

    // 用户取消 → 放掉：被挡住的入口拿到真的回合，照常接着走。
    const released = await freeze({ release: frozen.lease });
    assert.equal((await released.json() as { released: boolean }).released, true);
    const owner = await launch;
    assert.ok(owner, "放掉之后认领拿到的是真的回合，不是失败");
    releaseTurn("late", owner!);
    const claimed = await seat;
    assert.equal(claimed.ok, true, "并发名额照常占到");
    if (claimed.ok) releaseTurn("settling", claimed.turn);
    await thaw;
    const session = await terminal;
    assert.equal(terminalSessions.listForProject("p").length, 1, "新终端照常起来");
    await terminalSessions.destroy(session.id, "p");
    assert.equal((await restartImpact()).interrupted.some((item) => item.id === "late"), true, "解冻之后那一笔才落下");
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, "late"));
    assert.equal((await health()).freeze, null);
    assert.equal(events.at(-1)?.type === "service.freeze" && events.at(-1)?.freeze, null, "解冻也推事件");
    const stale = await freeze({ renew: frozen.lease });
    assert.equal((await stale.json() as { valid: boolean }).valid, false, "放掉之后凭据续不上");
    console.log("✓ 冻结后回合认领、并发名额、新终端都在等，名单不再变多；放掉之后它们照常接着走，拿到的是真回合");
  }

  // ── ③ 快照：占着回合锁还没跑起来的照实列出，落定了的不列 ─────────────────────────
  {
    const empty = async () => ({ survives: [], resumes: [], interrupted: [], mcpDisrupted: [] });
    const starting = claimOwnTurn("starting")!;
    const settling = claimOwnTurn("settling")!;
    setTimeout(() => releaseTurn("settling", settling), 300);
    const began = Date.now();
    const result = await acquireRestartFreeze(30_000, empty);
    assert.ok(!("busy" in result));
    if (!("busy" in result)) {
      const listed = result.impact.interrupted;
      assert.deepEqual(listed.map((item) => item.id), ["starting"], "到点还在起跑的列进来，自己还了锁的不列");
      assert.equal(listed[0].title, "任务 starting");
      assert.match(listed[0].reason, /正在起跑/);
      assert.ok(Date.now() - began >= 3_500, "给还在路上的回合一小会儿落定，而不是一冻就列");
      assert.ok(result.expiresInMs > 25_000, "快照花掉的时间不算持有者的");
      await freeze({ release: result.lease });
    }
    releaseTurn("starting", starting);
    console.log("✓ 冻结之下的快照：还在起跑的照实列出（带原因），落定了的不列");
  }

  // ── ⑤ 持有者不续也不放：到期自己解冻 ─────────────────────────────────────────────
  {
    const held = reserveServiceFreeze("restart", 150)!;
    const waiting = claimOwnTurnWhenReady("expiry");
    await sleep(50);
    assert.equal(await settled(waiting), false);
    // 到期的定时器不拖住进程退出（服务里事件循环本来就一直转着）；这里替它把循环撑住。
    const alive = setInterval(() => {}, 50);
    const owner = await waiting;
    clearInterval(alive);
    assert.ok(owner, "到期解冻之后等着的认领照常拿到回合");
    releaseTurn("expiry", owner!);
    assert.equal(serviceFrozen(), false);
    const expired = await freeze({ renew: held.token });
    assert.equal((await expired.json() as { valid: boolean }).valid, false, "过期的凭据续不上");
    console.log("✓ 持有者崩了（不续也不放）：冻结到期自己解，等着的入口照常接着走");
  }
} finally {
  offBus();
  lock!.release();
  await removeTmpStage(stage);
}
