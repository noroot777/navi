// 交卷扛得住重启（server/src/request-receipts.ts、runtime-handover-gate.ts 关服关门、singleton.ts 排空在途请求，
// mcp/src/runtime.ts 带请求号重试）：
//   ① 记账：同一个请求号只执行一次 —— 重来回放记下的答复、并发的等前一个、换了请求（正文、身份）的拒、
//      里层答「未执行」的不占号、记在另一本账上的不执行；上一份服务执行到一半的：业务提交时记下了答复的回放它，
//      认得回那一笔的端点（complete/pause/ask/stage）重进，其余如实答「不确定」；答复记不下就不回账本号
//   ② MCP：头一次写之前问不到账本号就等着问到（第 2 轮审查 F2）；「送到了一半」的写请求只在这次调用绑定了
//      一本账、而且重发前核对过对面还是那本账时才带原请求号重发（换成不记账的服务、换了库都如实说不确定）
//   ③ 真停服务（子进程当服务，SIGTERM 走 singleton.ts 的信号处理器）：
//      · 处理交卷时被为重启而停：处理完、答复送到才退，只执行一次，不用重试
//      · 处理超过排空上限：退出日志如实列出这一个；交卷在新服务上按请求号重做，生效一次
//      · 停机期间新发起的交卷：旧服务答「未执行」，新服务起来后成功，旧服务一次都没执行它
//      · 执行完、答复没送出去就被强杀：新服务回放记下的答复，不再执行
//      · 业务落了库、回执还没记就被强杀（第 1 轮审查 F1）：完成/暂停当场交出的哨兵结果，重试交回同一批、
//        同一个交付号；暂停写下的检查点、提问、上报阶段回放同一个事务里记下的答复，代次只 +1、问题只挂一次
//      · 上报阶段还没进业务就被强杀：新服务上照常执行一次（阶段两条提交路径的进程内覆盖见 test-stage-request-recovery.ts）
// 「agent」是本进程里真的 MCP 工具函数（mcp/src/tools/task-turn.ts），不拉起任何 CLI。③ 只在 POSIX 上跑：
// Windows 停服务不发信号（整树结束），强杀那一条走的是同一份记账，①② 已钉住。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Hono } from "hono";
import { NAVI_TURN_IDENTITY_ENV, NAVI_TURN_IDENTITY_ENV_ALL_KEYS, isTurnIdentityPathEntry } from "@navi/shared/mcp";
import { envNameGenerations } from "@navi/shared/env-names";
import { NAVI_TURN_FINGERPRINT_ENV } from "@navi/shared/turn-fingerprint";
import { withTestResources } from "../../scripts/test-process-resources.mjs";

const TOKEN = "turn-restart-delivery";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 子进程：一份「服务」——真单例锁与信号处理器、真关门闸、真记账、真完成确认路由 ──────────────────────
if (process.argv[2] === "serve") {
  const [, , , port, delayTask, delayMs, killTask, crashTask, abortTask] = process.argv;
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  assert.ok(acquireDbSingletonLock({ port: Number(port) }));
  const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
  await ensureSchema();
  const { projects, scheduledMessages, sessions, tasks } = await import("../src/db/schema.js");
  const { claimOwnTurn, bindTurnToken } = await import("../src/runs.js");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: tmpdir(), createdAt: at }).onConflictDoNothing();
  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]) {
    await db.insert(tasks).values({ id, projectId: "p", title: id, body: "", status: "running", agentType: "claude", mode: "single",
      workflowMode: "preset", activeTurnToken: TOKEN, createdAt: at, updatedAt: at }).onConflictDoNothing();
    await db.insert(sessions).values({ id: `s-${id}`, taskId: id, role: "single", agentType: "claude", executor: "claude", startedAt: at })
      .onConflictDoNothing();
    // t5（完成）、t6（暂停）托盘里排着一条哨兵结果：这一次调用会当场交出去
    if (id === "t5" || id === "t6") {
      await db.insert(scheduledMessages).values({ id: `msg-${id}`, taskId: id, text: `RESULT-${id}`, origin: `monitor:m-${id}`,
        mode: "queued", status: "pending", sendAt: at, createdAt: at }).onConflictDoNothing();
    }
    // 接回在跑的回合（真服务里是 reattach 做的）
    const owner = claimOwnTurn(id);
    assert.ok(owner);
    bindTurnToken(id, TOKEN, "claude");
  }
  const { runtimeHandoverGate } = await import("../src/runtime-handover-gate.js");
  const { requestReceipts } = await import("../src/request-receipts.js");
  const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
  const { mountTaskStageRoutes } = await import("../src/task-stage.js");
  const { serve } = await import("@hono/node-server");
  const api = new Hono();
  mountTaskRunRoutes(api);
  mountTaskStageRoutes(api);
  // 业务落了库、回执还没记就被强杀：记答复那一笔落库之前
  const execute = dbClient.execute.bind(dbClient);
  dbClient.execute = (async (statement: Parameters<typeof execute>[0]) => {
    if (crashTask && typeof statement !== "string" && statement.sql.startsWith("UPDATE request_receipts SET status")) {
      const row = (await execute({ sql: "SELECT path FROM request_receipts WHERE request_id = ?", args: [statement.args!.at(-1)!] } as never)).rows[0];
      if (String(row?.path).startsWith(`/api/tasks/${crashTask}/`)) process.kill(process.pid, "SIGKILL");
    }
    return execute(statement);
  }) as typeof dbClient.execute;
  const app = new Hono();
  // 执行完、答复还没写出去就被强杀（最外层：里面的记账已经落了库）
  app.use("/api/tasks/:id/complete", async (c, next) => {
    await next();
    if (c.req.param("id") === killTask) process.kill(process.pid, "SIGKILL");
  });
  app.use("*", runtimeHandoverGate());
  app.use("/api/*", requestReceipts());
  app.get("/api/health", (c) => c.json({ ok: true }));
  // 处理函数真正开始执行的那一刻记一笔，指定的那一条在这里拖住（处理中）
  app.use("/api/tasks/:id/:verb", async (c, next) => {
    console.log(`ENTER ${c.req.param("id")}`);
    // 已经开始记账、还没进业务就被强杀
    if (c.req.param("id") === abortTask) process.kill(process.pid, "SIGKILL");
    if (c.req.param("id") === delayTask) await sleep(Number(delayMs));
    return next();
  });
  app.get("/api/state", async (c) => c.json({
    tasks: await db.select({ id: tasks.id, confirmed: tasks.completeConfirmedAt, resumePrompt: tasks.resumePrompt,
      generation: tasks.resumePromptGeneration, question: tasks.question, stage: tasks.stage }).from(tasks),
    receipts: (await dbClient.execute("SELECT path, status FROM request_receipts")).rows,
    messages: await db.select({ id: scheduledMessages.id, status: scheduledMessages.status, handoff: scheduledMessages.turnHandoff })
      .from(scheduledMessages),
  }));
  app.route("/api", api);
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(port) }, () => console.log("READY"));
} else {
  await import("./isolated-data.js");
  const freePort = () => new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const port = await freePort();
  process.env.NAVI_URL = `http://127.0.0.1:${port}`;
  // 跑这份测试的进程自己可能就在一个 navi 回合里：它的回合身份（三条通道、回合指纹）不能漏进这里的 MCP
  for (const key of [...NAVI_TURN_IDENTITY_ENV_ALL_KEYS, ...envNameGenerations(NAVI_TURN_FINGERPRINT_ENV as `NAVI_${string}`)]) {
    delete process.env[key];
  }
  process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((entry) => !isTurnIdentityPathEntry(entry)).join(delimiter);
  process.env[NAVI_TURN_IDENTITY_ENV.turnToken] = TOKEN;
  // MCP 的重试日志走 stderr（console.error）：截下来看它重试了什么、凭什么码
  const retries: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[navi-mcp]")) retries.push(line); else consoleError(...args);
  };
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
  const { registerTaskTurnTools } = await import("../../mcp/src/tools/task-turn.js");
  registerTaskTurnTools({ registerTool(name: string, _config: unknown, handler: never) { handlers.set(name, handler); } } as never);
  const complete = (taskId: string) => handlers.get("complete_task")!({ taskId, directionToken: "" });
  const pause = (taskId: string) => handlers.get("pause_task")!({ taskId, resumePrompt: "WAIT", directionToken: "" });
  const ask = (taskId: string) => handlers.get("ask_question")!({ taskId, question: "Q?", directionToken: "" });
  const stage = (taskId: string) => handlers.get("report_stage")!({ taskId, stage: "implemented", directionToken: "" });
  const { call } = await import("../../mcp/src/runtime.js");

  // ── ① 记账（进程内，生产中间件 + 临时库）──────────────────────────────────────────────────────────
  {
    const { ensureSchema, dbClient } = await import("../src/db/index.js");
    await ensureSchema();
    const { requestReceipts, REQUEST_OUTCOME_UNKNOWN } = await import("../src/request-receipts.js");
    const ledger = String((await dbClient.execute("SELECT value FROM app_settings WHERE key = 'request_receipt_ledger'")).rows[0]!.value);
    const ran = new Map<string, number>();
    const app = new Hono();
    app.use("/api/*", requestReceipts());
    app.post("/api/:what/:id?/:verb?", async (c) => {
      const key = c.req.path;
      ran.set(key, (ran.get(key) ?? 0) + 1);
      if (c.req.param("what") === "slow") await sleep(200);
      if (c.req.param("what") === "undelivered") {
        c.header("x-navi-undelivered", "runtime-handoff-v1");
        return c.json({ error: "not executed" }, 503);
      }
      return c.json({ n: ran.get(key), body: await c.req.text() });
    });
    app.get("/api/read", (c) => c.json({ ok: true }));
    const post = (path: string, id: string, headers: Record<string, string> = {}, body = "") =>
      app.request(path, { method: "POST", headers: { "x-navi-request-id": id, "x-navi-turn-token": TOKEN, ...headers }, body });

    const first = await post("/api/do", "req-aaaaaaaa");
    assert.equal(first.headers.get("x-navi-request-receipt"), ledger, "记下了：回这本账的账本号");
    assert.equal(first.headers.get("x-navi-request-replayed"), null);
    const again = await post("/api/do", "req-aaaaaaaa");
    assert.equal(again.headers.get("x-navi-request-replayed"), "1");
    assert.equal(again.headers.get("x-navi-request-receipt"), ledger);
    assert.deepEqual(await again.json(), await first.json());
    assert.equal(ran.get("/api/do"), 1, "同一个请求号重来：回放，不再执行");
    const [a, b] = await Promise.all([post("/api/slow", "req-bbbbbbbb"), post("/api/slow", "req-bbbbbbbb")]);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(ran.get("/api/slow"), 1, "并发的两个同号请求：后一个等前一个处理完再回放");
    assert.equal((await post("/api/other", "req-aaaaaaaa")).status, 409, "请求号换了请求：不执行");
    assert.equal((await post("/api/do", "req-aaaaaaaa", { "x-navi-turn-token": "someone-else" })).status, 409, "换了回合身份也不认");
    assert.equal((await post("/api/do", "req-aaaaaaaa", { "x-navi-direction-token": "other" })).status, 409, "换了方向身份也不认");
    assert.equal((await post("/api/do", "req-aaaaaaaa", {}, '{"value":2}')).status, 409, "换了正文也不认（第 1 轮审查 N1）");
    assert.equal(ran.get("/api/other"), undefined);
    assert.equal(ran.get("/api/do"), 1);
    await post("/api/undelivered", "req-cccccccc");
    await post("/api/undelivered", "req-cccccccc");
    assert.equal(ran.get("/api/undelivered"), 2, "里层答了「未执行」：不占请求号，重来照常执行");
    const read = await app.request("/api/read", { headers: { "x-navi-request-id": "req-dddddddd" } });
    assert.equal(read.headers.get("x-navi-request-receipt"), ledger, "读请求也回账本号（MCP 据此知道这份服务记的是哪本账）");
    assert.equal((await dbClient.execute("SELECT count(*) AS n FROM request_receipts WHERE request_id = 'req-dddddddd'")).rows[0]!.n, 0, "读请求不记账");
    assert.equal((await post("/api/do", "x")).status, 400, "请求号格式不对：不执行");

    // 上一份服务执行到一半停掉了：库里只有「开始了」那一行（先正常走一遍拿到同一份指纹，再把答复抹掉）
    const orphan = async (id: string, path: string, effect: string | null = null) => {
      await post(path, id);
      await dbClient.execute({ sql: "UPDATE request_receipts SET status = NULL, content_type = NULL, body = NULL, answered_at = NULL, effect = ?"
        + " WHERE request_id = ?", args: [effect, id] });
    };
    await orphan("req-eeeeeeee", "/api/dispatch");
    const unknown = await post("/api/dispatch", "req-eeeeeeee");
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), { error: REQUEST_OUTCOME_UNKNOWN, outcome: "unknown" });
    assert.equal(ran.get("/api/dispatch"), 1, "认不出做过的那一笔的端点执行到一半：如实答不确定，不替调用方重做");
    for (const [id, verb] of [["req-ffffffff", "complete"], ["req-gggggggg", "stage"]] as const) {
      const path = `/api/tasks/t9/${verb}`;
      await orphan(id, path);
      assert.equal((await post(path, id)).status, 200);
      assert.equal(ran.get(path), 2, `${verb} 执行到一半、没有记下答复：重进端点（没提交就是第一次做，提交了由端点认回）`);
      assert.equal((await post(path, id)).headers.get("x-navi-request-replayed"), "1", "重进完照样记账");
    }
    const wrongLedger = await post("/api/do", "req-jjjjjjjj", { "x-navi-request-ledger": "another-ledger" });
    assert.equal(wrongLedger.status, 409, "重发的调用记在另一本账上：不执行");
    assert.equal(wrongLedger.headers.get("x-navi-request-receipt"), ledger, "回这一本的账本号，MCP 据此判断");
    assert.equal(ran.get("/api/do"), 1);
    assert.equal((await post("/api/do", "req-kkkkkkkk", { "x-navi-request-ledger": ledger })).status, 200, "账本号对得上：照常");
    await orphan("req-hhhhhhhh", "/api/tasks/t9/pause", '{"paused":true}');
    const effect = await post("/api/tasks/t9/pause", "req-hhhhhhhh");
    assert.equal(effect.headers.get("x-navi-request-replayed"), "1");
    assert.deepEqual(await effect.json(), { paused: true }, "业务提交时记下了答复：回放它");
    assert.equal(ran.get("/api/tasks/t9/pause"), 1, "不再进端点");
    assert.equal((await post("/api/tasks/t9/pause", "req-hhhhhhhh")).status, 200, "回放过一次之后照常回放");

    // 答复记不下：这一次照常答，但不回账本号；带同一个请求号再来，按「没答完」处置
    const execute = dbClient.execute.bind(dbClient);
    dbClient.execute = (async (statement: Parameters<typeof execute>[0]) => {
      if (typeof statement !== "string" && statement.sql.startsWith("UPDATE request_receipts SET status")) throw new Error("disk full");
      return execute(statement);
    }) as typeof dbClient.execute;
    const consoleWarn = console.warn;
    console.warn = () => {};
    const flaky = await post("/api/flaky", "req-iiiiiiii");
    console.warn = consoleWarn;
    dbClient.execute = execute as typeof dbClient.execute;
    assert.equal(flaky.status, 200);
    assert.equal(flaky.headers.get("x-navi-request-receipt"), null, "回执没记下：不回账本号，不谎称记了账");
    assert.equal((await post("/api/flaky", "req-iiiiiiii")).status, 409);
    assert.equal(ran.get("/api/flaky"), 1);
    console.log("✓ 同一个请求号只执行一次；执行到一半的：记下了答复的回放、认得回那一笔的端点重进、其余如实答不确定；记不下回执不回账本号");
  }

  // ── ② MCP 的重发判据（假服务：第一次把连接掐断）─────────────────────────────────────────────────────
  {
    const seen = new Map<string, string[]>();
    let ledger: string | null = "ledger-zero";
    let onBreak: (() => void) | null = null;
    let asked = 0;
    const ledgers: string[] = [];
    const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
      const headers = { "content-type": "application/json", ...(ledger ? { "x-navi-request-receipt": ledger } : {}) };
      if (req.url === "/api/health") {
        asked += 1;
        // 头两次像刚起来的服务那样答「未执行」（初始化中）
        if (asked <= 2) { res.writeHead(503, { "x-navi-undelivered": "runtime-handoff-v1" }); res.end("initializing"); return; }
        res.writeHead(200, headers); res.end('{"ok":true}'); return;
      }
      ledgers.push(String(req.headers["x-navi-request-ledger"] ?? ""));
      const ids = seen.get(req.url!) ?? [];
      ids.push(String(req.headers["x-navi-request-id"]));
      seen.set(req.url!, ids);
      if (req.method !== "GET" && ids.length === 1) { onBreak?.(); req.socket.destroy(); return; }
      res.writeHead(200, headers);
      res.end('{"ok":true}');
    });
    await withTestResources(async () => {
      fake.listen(port, "127.0.0.1");
      await once(fake, "listening");
      assert.deepEqual(await call("POST", "/tasks/t/complete", {}), { ok: true });
      assert.ok(asked >= 3, "头一次写之前问不到账本号：等到问到为止，不是问一次就算");
      const complete = seen.get("/api/tasks/t/complete")!;
      assert.equal(complete.length, 2, "服务刚起来时的头一笔写断在半路：凭等来的账本号带原请求号重发（第 2 轮审查 F2）");
      assert.equal(complete[0], complete[1]);
      assert.deepEqual(ledgers.slice(-2), ["ledger-zero", "ledger-zero"], "发出去的每一次都带着这次调用绑定的账本号");
      ledger = "ledger-one";
      await call("GET", "/tasks");
      assert.deepEqual(await call("POST", "/tasks/t/run", {}), { ok: true });
      const run = seen.get("/api/tasks/t/run")!;
      assert.equal(run.length, 2, "知道账本号、重发前核对过还是那本账：带原请求号重发");
      assert.equal(run[0], run[1]);
      onBreak = () => { ledger = null; };
      await assert.rejects(call("POST", "/tasks/t/stop", {}), /重试打到的服务不是记着这次调用的那一份/);
      assert.equal(seen.get("/api/tasks/t/stop")!.length, 1, "见过账本号、但重试打到的服务不记账了（降级）：不重发（第 1 轮审查 N2）");
      ledger = "ledger-one";
      await call("GET", "/tasks");
      onBreak = () => { ledger = "ledger-two"; };
      await assert.rejects(call("POST", "/tasks/t/archive", {}), /重试打到的服务不是记着这次调用的那一份/);
      assert.equal(seen.get("/api/tasks/t/archive")!.length, 1, "换了一本账（换了库）：不重发");
      // 断在半路之后，并发的读请求拿到了换库后的账本号：这次调用仍只认它绑定的那一本（第 2 轮审查 N1）
      ledger = "ledger-one";
      await call("GET", "/tasks");
      onBreak = () => { ledger = "ledger-three"; void call("GET", "/tasks"); };
      await assert.rejects(call("POST", "/tasks/t/rename", {}), /重试打到的服务不是记着这次调用的那一份/);
      assert.equal(seen.get("/api/tasks/t/rename")!.length, 1, "并发读请求改写了全局账本号，也不重发");
    }, [async () => { if (fake.listening) await new Promise((done) => fake.close(done)); }]);
    retries.length = 0;
    console.log("✓ MCP：头一次写之前等到账本号；断在半路的写请求只在重发前核对过还是它绑定的那本账时才带原请求号重发，否则如实说不确定");
  }

  // ── ③ 真停服务 ──────────────────────────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    console.log("- 跳过真停服务：Windows 停服务不发信号（整树结束）");
  } else {
    const root = mkdtempSync(join(tmpdir(), "navi-restart-delivery-"));
    mkdirSync(join(root, "home"));
    const children = new Set<ChildProcess>();
    type Served = { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };
    const startServer = async (delayTask = "", delayMs = 0, killTask = "", crashTask = "", abortTask = ""): Promise<Served> => {
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "serve", String(port), delayTask, String(delayMs), killTask, crashTask, abortTask], {
        cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: join(root, "home"), NAVI_DATA_DIR: root, NAVI_DB: join(root, "t.db"), NAVI_RUNS_DIR: join(root, "runs") },
      });
      children.add(child);
      let out = "";
      let err = "";
      child.stdout!.on("data", (chunk) => { out += chunk; });
      child.stderr!.on("data", (chunk) => { err += chunk; });
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code, signal) => { children.delete(child); resolve(code ?? (signal ? -1 : null)); }));
      for (let i = 0; i < 300 && !out.includes("READY"); i++) await sleep(100);
      assert.ok(out.includes("READY"), `「服务」没起来：${out}${err}`);
      return { child, out: () => out, err: () => err, exited };
    };
    const until = async (what: string, check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++) await sleep(50);
      assert.ok(check(), what);
    };
    const entered = (served: Served[], taskId: string) =>
      served.reduce((sum, s) => sum + s.out().split("\n").filter((line) => line === `ENTER ${taskId}`).length, 0);
    const state = async () => (await (await fetch(`${process.env.NAVI_URL}/api/state`)).json()) as {
      tasks: { id: string; confirmed: string | null; resumePrompt: string | null; generation: number; question: string | null; stage: string | null }[];
      receipts: { path: string; status: number | null }[];
      messages: { id: string; status: string; handoff: { hand: string; request?: string } | null }[];
    };
    const task = async (taskId: string) => (await state()).tasks.find((t) => t.id === taskId)!;
    const confirmed = async (taskId: string) => (await state()).tasks.find((t) => t.id === taskId)?.confirmed ?? null;

    await withTestResources(async () => {
      // 处理交卷时被为重启而停：排空等它处理完、答复送到才退
      const first = await startServer("t1", 1_500);
      const calling = complete("t1");
      await until("t1 的交卷进了处理函数", () => entered([first], "t1") === 1);
      first.child.kill("SIGTERM");
      const done = await calling;
      assert.notEqual(done.isError, true, `交卷成功：${done.content[0]!.text}`);
      assert.match(done.content[0]!.text, /"confirmed": true/);
      assert.equal(await first.exited, 143, "处理完才按 SIGTERM 退");
      assert.doesNotMatch(first.err(), /没处理完/);
      assert.equal(retries.length, 0, "答复在旧服务退出之前就送到了，不用重试");
      const second = await startServer("t2", 20_000);
      assert.ok(await confirmed("t1"), "确认落了库");
      assert.equal(entered([first, second], "t1"), 1, "只执行了一次");
      console.log("✓ 处理交卷时被为重启而停：处理完、答复送到才退，只执行一次");

      // 处理超过排空上限 + 停机期间新发起的交卷
      const slow = complete("t2");
      await until("t2 的交卷进了处理函数", () => entered([second], "t2") === 1);
      second.child.kill("SIGTERM");
      await sleep(300);
      const during = complete("t3");
      await until("停机期间新发起的交卷被答「未执行」", () => retries.some((line) => /NAVI_RUNTIME_UNDELIVERED.*\/tasks\/t3\/complete/.test(line)));
      assert.equal(await second.exited, 143);
      assert.match(second.err(), /退出前还有 1 个请求超过 6 秒没处理完[^\n]*POST \/api\/tasks\/t2\/complete/, "没处理完的那一个如实写进退出日志");
      const third = await startServer();
      const [slowDone, duringDone] = await Promise.all([slow, during]);
      assert.notEqual(slowDone.isError, true, `被截断的交卷在新服务上成功：${slowDone.content[0]!.text}`);
      assert.notEqual(duringDone.isError, true, `停机期间发起的交卷在新服务上成功：${duringDone.content[0]!.text}`);
      assert.ok(retries.some((line) => /(UND_ERR_SOCKET|ECONNRESET).*\/tasks\/t2\/complete/.test(line)), retries.join("\n"));
      assert.equal(entered([second], "t3"), 0, "停机期间发起的那一个，旧服务一次都没执行");
      assert.equal(entered([third], "t3"), 1);
      assert.equal(entered([second, third], "t2"), 2, "被截断的那一个在新服务上按请求号重做了一遍");
      assert.ok(await confirmed("t2"));
      assert.ok(await confirmed("t3"));
      assert.equal((await state()).receipts.filter((r) => r.path === "/api/tasks/t2/complete").length, 1, "重做用的是同一个请求号");
      console.log("✓ 处理超过排空上限：退出日志如实列出，交卷在新服务上按请求号重做、生效一次；停机期间新发起的交卷在新服务上成功");
      third.child.kill("SIGTERM");
      await third.exited;

      // 执行完、答复没送出去就被强杀：新服务回放
      const fourth = await startServer("", 0, "t4");
      retries.length = 0;
      const lost = complete("t4");
      assert.equal(await fourth.exited, -1, "处理完就被强杀");
      const fifth = await startServer();
      const lostDone = await lost;
      assert.notEqual(lostDone.isError, true, lostDone.content[0]!.text);
      assert.match(lostDone.content[0]!.text, /"confirmed": true/, "拿到的是旧服务记下的那份答复");
      assert.equal(entered([fourth, fifth], "t4"), 1, "新服务回放，不再执行");
      assert.ok(retries.length > 0);
      console.log("✓ 执行完、答复没送出去就被强杀：新服务按请求号回放记下的答复，不再执行");
      fifth.child.kill("SIGTERM");
      await fifth.exited;

      // 业务落了库、回执还没记就被强杀（第 1 轮审查 F1）：每一条都在下一份服务上续上，下一份服务再掐下一条
      const crashed: Served[] = [];
      const crashing = async (taskId: string, run: () => ReturnType<typeof complete>, before = false) => {
        const served = await startServer("", 0, "", before ? "" : taskId, before ? taskId : "");
        crashed.push(served);
        const result = run();
        assert.equal(await served.exited, -1, `${taskId}：业务落库之后、回执记下之前被强杀`);
        // 包一层：直接返回 promise 会被 async 函数接过去等它（而它要等下一份服务起来）
        return { result };
      };
      const handOf = async (taskId: string) => (await state()).messages.find((m) => m.id === `msg-${taskId}`)!.handoff;
      const { result: t5 } = await crashing("t5", () => complete("t5"));
      const { result: t6 } = await crashing("t6", async () => {
        const done = await t5;
        const handoff = await handOf("t5");
        assert.ok(handoff?.request, "交出去的那一批记着是哪一次调用领走的");
        assert.equal(done.isError, true, "完成这一次没生效（结果随拒绝交出来）");
        assert.match(done.content[0]!.text, /RESULT-t5/, `重试交回了那一批：${done.content[0]!.text}`);
        assert.ok(done.content[0]!.text.includes(handoff.hand), "交回的是同一个交付号，不是被当成「交过、没带回回执号」拦下");
        assert.equal(entered(crashed, "t5"), 2, "complete 重进端点，由它认回那一笔");
        return pause("t6");
      });
      const { result: t7 } = await crashing("t7", async () => {
        const done = await t6;
        const handoff = await handOf("t6");
        assert.notEqual(done.isError, true, done.content[0]!.text);
        assert.match(done.content[0]!.text, /RESULT-t6/);
        assert.ok(done.content[0]!.text.includes(handoff!.hand), "暂停：交回同一批、同一个交付号");
        const t6Row = await task("t6");
        assert.equal(t6Row.resumePrompt, null, "交了结果就不暂停：重试也没有改成去占检查点");
        assert.equal(t6Row.generation, 0);
        return pause("t7");
      });
      const { result: t8 } = await crashing("t8", async () => {
        const done = await t7;
        assert.notEqual(done.isError, true, done.content[0]!.text);
        assert.match(done.content[0]!.text, /"paused": true/, "回放写检查点那一笔记下的答复");
        const t7Row = await task("t7");
        assert.equal(t7Row.resumePrompt, "WAIT");
        assert.equal(t7Row.generation, 1, "检查点只占了一次：代次 +1，不是 +2");
        assert.equal(entered(crashed, "t7"), 1, "回放，不再进端点");
        return ask("t8");
      });
      const { result: t9 } = await crashing("t9", async () => {
        const asked = await t8;
        assert.notEqual(asked.isError, true, asked.content[0]!.text);
        assert.match(asked.content[0]!.text, /"asked": true/, "回放挂问题那一笔记下的答复");
        assert.equal((await task("t8")).question, "Q?");
        assert.equal(entered(crashed, "t8"), 1, "问题只挂了一次");
        return stage("t9");
      });
      const { result: t10 } = await crashing("t10", async () => {
        const reported = await t9;
        assert.notEqual(reported.isError, true, `上报阶段在新服务上拿回原来的答复：${reported.content[0]!.text}`);
        assert.match(reported.content[0]!.text, /"reported": true/);
        assert.equal((await task("t9")).stage, "implemented");
        assert.equal(entered(crashed, "t9"), 1, "回放，不再进端点（第 2 轮审查 F1）");
        return stage("t10");
      }, true);
      const sixth = await startServer();
      crashed.push(sixth);
      const late = await t10;
      assert.notEqual(late.isError, true, `还没进业务就被强杀：新服务上照常执行：${late.content[0]!.text}`);
      assert.equal((await task("t10")).stage, "implemented");
      assert.equal(entered(crashed, "t10"), 2);
      console.log("✓ 业务落了库、回执没记就被强杀：交出的哨兵结果按请求号交回同一批，检查点、提问与阶段回放同一个事务里记下的答复；没进业务的照常执行");
      sixth.child.kill("SIGTERM");
      await sixth.exited;
    }, [
      () => { for (const child of children) child.kill("SIGKILL"); },
      () => rmSync(root, { recursive: true, force: true }),
    ]);
  }
  console.error = consoleError;
}
