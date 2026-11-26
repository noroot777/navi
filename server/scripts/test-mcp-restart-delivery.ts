// 交卷扛得住重启（server/src/request-receipts.ts、runtime-handover-gate.ts 关服关门、singleton.ts 排空在途请求，
// mcp/src/runtime.ts 带请求号重试）：
//   ① 记账：同一个请求号只执行一次 —— 重来回放记下的答复、并发的等前一个、换了请求的拒、里层答「未执行」的不占号；
//      上一份服务执行到一半的：交卷端点重做，其余如实答「不确定」
//   ② MCP：「送到了一半」只在交卷端点、或见过这份服务的记账回执头之后才带原请求号重试，否则如实说不确定
//   ③ 真停服务（子进程当服务，SIGTERM 走 singleton.ts 的信号处理器）：
//      · 处理交卷时被为重启而停：处理完、答复送到才退，只执行一次，不用重试
//      · 处理超过排空上限：退出日志如实列出这一个；交卷在新服务上按请求号重做，生效一次
//      · 停机期间新发起的交卷：旧服务答「未执行」，新服务起来后成功，旧服务一次都没执行它
//      · 执行完、答复没送出去就被强杀：新服务回放记下的答复，不再执行
// 「agent」是本进程里真的 MCP 工具函数（mcp/src/tools/task-turn.ts），不拉起任何 CLI。③ 只在 POSIX 上跑：
// Windows 停服务不发信号（整树结束），强杀那一条走的是同一份记账，①② 已钉住。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { NAVI_TURN_IDENTITY_ENV } from "@navi/shared/mcp";
import { withTestResources } from "../../scripts/test-process-resources.mjs";

const TOKEN = "turn-restart-delivery";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 子进程：一份「服务」——真单例锁与信号处理器、真关门闸、真记账、真完成确认路由 ──────────────────────
if (process.argv[2] === "serve") {
  const [, , , port, delayTask, delayMs, killTask] = process.argv;
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  assert.ok(acquireDbSingletonLock({ port: Number(port) }));
  const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
  await ensureSchema();
  const { projects, tasks } = await import("../src/db/schema.js");
  const { claimOwnTurn, bindTurnToken } = await import("../src/runs.js");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: tmpdir(), createdAt: at }).onConflictDoNothing();
  for (const id of ["t1", "t2", "t3", "t4"]) {
    await db.insert(tasks).values({ id, projectId: "p", title: id, body: "", status: "running", agentType: "claude", mode: "single",
      activeTurnToken: TOKEN, createdAt: at, updatedAt: at }).onConflictDoNothing();
    // 接回在跑的回合（真服务里是 reattach 做的）
    const owner = claimOwnTurn(id);
    assert.ok(owner);
    bindTurnToken(id, TOKEN, "claude");
  }
  const { runtimeHandoverGate } = await import("../src/runtime-handover-gate.js");
  const { requestReceipts } = await import("../src/request-receipts.js");
  const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
  const { serve } = await import("@hono/node-server");
  const api = new Hono();
  mountTaskRunRoutes(api);
  const app = new Hono();
  // 执行完、答复还没写出去就被强杀（最外层：里面的记账已经落了库）
  app.use("/api/tasks/:id/complete", async (c, next) => {
    await next();
    if (c.req.param("id") === killTask) process.kill(process.pid, "SIGKILL");
  });
  app.use("*", runtimeHandoverGate());
  app.use("/api/*", requestReceipts());
  // 处理函数真正开始执行的那一刻记一笔，指定的那一条在这里拖住（处理中）
  app.use("/api/tasks/:id/complete", async (c, next) => {
    console.log(`ENTER ${c.req.param("id")}`);
    if (c.req.param("id") === delayTask) await sleep(Number(delayMs));
    return next();
  });
  app.get("/api/state", async (c) => c.json({
    tasks: await db.select({ id: tasks.id, confirmed: tasks.completeConfirmedAt }).from(tasks),
    receipts: (await dbClient.execute("SELECT path, status FROM request_receipts")).rows,
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
  const { call } = await import("../../mcp/src/runtime.js");

  // ── ① 记账（进程内，生产中间件 + 临时库）──────────────────────────────────────────────────────────
  {
    const { ensureSchema, dbClient } = await import("../src/db/index.js");
    await ensureSchema();
    const { requestReceipts, REQUEST_OUTCOME_UNKNOWN } = await import("../src/request-receipts.js");
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
      return c.json({ n: ran.get(key) });
    });
    app.get("/api/read", (c) => c.json({ ok: true }));
    const post = (path: string, id: string, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", headers: { "x-navi-request-id": id, "x-navi-turn-token": TOKEN, ...headers } });

    const first = await post("/api/do", "req-aaaaaaaa");
    assert.equal(first.headers.get("x-navi-request-receipt"), "recorded");
    const again = await post("/api/do", "req-aaaaaaaa");
    assert.equal(again.headers.get("x-navi-request-receipt"), "replayed");
    assert.deepEqual(await again.json(), await first.json());
    assert.equal(ran.get("/api/do"), 1, "同一个请求号重来：回放，不再执行");
    const [a, b] = await Promise.all([post("/api/slow", "req-bbbbbbbb"), post("/api/slow", "req-bbbbbbbb")]);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(ran.get("/api/slow"), 1, "并发的两个同号请求：后一个等前一个处理完再回放");
    assert.equal((await post("/api/other", "req-aaaaaaaa")).status, 409, "请求号换了请求：不执行");
    assert.equal((await post("/api/do", "req-aaaaaaaa", { "x-navi-turn-token": "someone-else" })).status, 409, "换了回合身份也不认");
    assert.equal(ran.get("/api/other"), undefined);
    await post("/api/undelivered", "req-cccccccc");
    await post("/api/undelivered", "req-cccccccc");
    assert.equal(ran.get("/api/undelivered"), 2, "里层答了「未执行」：不占请求号，重来照常执行");
    const read = await app.request("/api/read", { headers: { "x-navi-request-id": "req-dddddddd" } });
    assert.equal(read.headers.get("x-navi-request-receipt"), "recorded", "读请求也回回执头（MCP 据此知道这份服务记账）");
    assert.equal((await dbClient.execute("SELECT count(*) AS n FROM request_receipts WHERE request_id = 'req-dddddddd'")).rows[0]!.n, 0, "读请求不记账");
    assert.equal((await post("/api/do", "x")).status, 400, "请求号格式不对：不执行");

    // 上一份服务执行到一半停掉了：库里只有「开始了」那一行
    const orphan = async (id: string, path: string) => {
      const { createHash } = await import("node:crypto");
      const fingerprint = createHash("sha256").update(["POST", path, "", TOKEN].join("\n")).digest("hex");
      await dbClient.execute({ sql: "INSERT INTO request_receipts (request_id, fingerprint, method, path, owner, started_at) VALUES (?, ?, 'POST', ?, 'gone', ?)",
        args: [id, fingerprint, path, new Date().toISOString()] });
    };
    await orphan("req-eeeeeeee", "/api/dispatch");
    const unknown = await post("/api/dispatch", "req-eeeeeeee");
    assert.equal(unknown.status, 409);
    assert.deepEqual(await unknown.json(), { error: REQUEST_OUTCOME_UNKNOWN, outcome: "unknown" });
    assert.equal(ran.get("/api/dispatch"), undefined, "非交卷端点执行到一半：如实答不确定，不替调用方重做");
    await orphan("req-ffffffff", "/api/tasks/t9/complete");
    assert.equal((await post("/api/tasks/t9/complete", "req-ffffffff")).status, 200);
    assert.equal(ran.get("/api/tasks/t9/complete"), 1, "交卷端点执行到一半：重做");
    assert.equal((await post("/api/tasks/t9/complete", "req-ffffffff")).headers.get("x-navi-request-receipt"), "replayed", "重做完照样记账");
    console.log("✓ 同一个请求号只执行一次；上一份服务执行到一半的，交卷端点重做、其余如实答不确定");
  }

  // ── ② MCP 的重试判据（假服务：第一次把连接掐断）─────────────────────────────────────────────────────
  {
    const seen = new Map<string, string[]>();
    let receipts = false;
    const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
      const ids = seen.get(req.url!) ?? [];
      ids.push(String(req.headers["x-navi-request-id"]));
      seen.set(req.url!, ids);
      if (req.method !== "GET" && ids.length === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json", ...(receipts ? { "x-navi-request-receipt": "recorded" } : {}) });
      res.end('{"ok":true}');
    });
    await withTestResources(async () => {
      fake.listen(port, "127.0.0.1");
      await once(fake, "listening");
      await assert.rejects(call("POST", "/tasks/t/dispatch", {}), /不确定它执行了没有/);
      assert.equal(seen.get("/api/tasks/t/dispatch")!.length, 1, "没见过记账回执头：非交卷调用断在半路不重试");
      assert.deepEqual(await call("POST", "/tasks/t/complete", {}), { ok: true });
      const [one, two] = seen.get("/api/tasks/t/complete")!;
      assert.equal(one, two, "交卷端点断在半路：带原请求号重试");
      receipts = true;
      await call("GET", "/tasks");
      assert.deepEqual(await call("POST", "/tasks/t/run", {}), { ok: true });
      const run = seen.get("/api/tasks/t/run")!;
      assert.equal(run.length, 2, "见过这份服务的记账回执头之后：断在半路的调用都带原请求号重试");
      assert.equal(run[0], run[1]);
    }, [async () => { if (fake.listening) await new Promise((done) => fake.close(done)); }]);
    retries.length = 0;
    console.log("✓ MCP：断在半路的写请求只在交卷端点、或见过记账回执头之后才带原请求号重试，否则如实说不确定");
  }

  // ── ③ 真停服务 ──────────────────────────────────────────────────────────────────────────────────
  if (process.platform === "win32") {
    console.log("- 跳过真停服务：Windows 停服务不发信号（整树结束）");
  } else {
    const root = mkdtempSync(join(tmpdir(), "navi-restart-delivery-"));
    mkdirSync(join(root, "home"));
    const children = new Set<ChildProcess>();
    type Served = { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };
    const startServer = async (delayTask = "", delayMs = 0, killTask = ""): Promise<Served> => {
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "serve", String(port), delayTask, String(delayMs), killTask], {
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
      tasks: { id: string; confirmed: string | null }[]; receipts: { path: string; status: number | null }[];
    };
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
    }, [
      () => { for (const child of children) child.kill("SIGKILL"); },
      () => rmSync(root, { recursive: true, force: true }),
    ]);
  }
  console.error = consoleError;
}
