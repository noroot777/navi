// 把自带的那份 navi 服务起起来（对应 mac 的 ServerLauncher.swift）：发布到 %LOCALAPPDATA%\Navi\runtimes\<sha256>\
// 的那份 node 跑那份 server，数据根、桌面版标记、本机模式、窗口专用端口由 server-env.mjs 定。
//
// 服务和壳解绑：关窗、退出壳、壳被强杀，都不带走服务和它名下在跑的 agent。Windows 上「解绑」有两层：
//   · 进程层：DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP（同 scripts/start-detached.mjs）；
//   · Job 层：壳要是被放进了带 KILL_ON_JOB_CLOSE 的 Job（从别的工具、终端里拉起时会这样），Job 一关它的
//     后代全被带走 —— libuv 的 detached 不设 CREATE_BREAKAWAY_FROM_JOB，node 自己做不到。所以真正拉起服务的
//     是壳的 `--spawn-detached`（shell/src/spawn.rs）：在 Job 里就带上 breakaway 起；Job 不许脱离、而且关掉时
//     会连带结束子进程的，不起，说清楚。
// 这里**只负责起**：不杀旧进程、不守护。同时来的请求合成一次。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { publishedRuntime } from "./config.mjs";
import { isServing, mismatch, probe as probeHealth } from "./health.mjs";
import { activeHold, isPidAlive } from "./maintenance.mjs";
import { serverEnvironment } from "./server-env.mjs";
import { allowsOtherDevices } from "./settings.mjs";
import { acquireStartLock } from "./start-lock.mjs";
import { portListeners, registryPath } from "./win-ps.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLauncher(cfg, overrides = {}) {
  const deps = {
    probe: () => probeHealth(cfg.baseURL),
    publish: () => publishRuntime(cfg),
    spawn: (runtime, env) => spawnServer(cfg, runtime, env),
    registryPath: () => (cfg.windows ? registryPath() : ""),
    listeners: (port) => (cfg.windows ? portListeners(port) : []),
    log: () => {},
    ...overrides,
  };
  let freshStartApproved = false;
  let pending = null;

  const isInitialized = () => cfg.initializedMarkers.some((file) => existsSync(file));

  /** 探到的结果里哪些已经是结论：自己那份在 → ready；别人占着 → occupied；连不上 → null（接着起）。 */
  function settle(result) {
    if (result.kind === "down" || result.kind === "unreachable") return null;
    if (result.kind === "notNavi") return { kind: "occupied", message: notNavi(result.what) };
    if (!isServing(result, cfg)) return { kind: "occupied", message: otherNavi(result.instance) };
    return { kind: "ready", instance: result.instance };
  }

  async function run(timeoutMs, onPhase) {
    const first = settle(await deps.probe());
    if (first) return first;
    let hold = activeHold(cfg);
    if (hold) return { kind: "failed", message: hold };
    if (!cfg.isLocal) return { kind: "failed", message: `连不上 ${cfg.baseURL}。它不是本机地址，app 不会替它启动服务。` };
    if (!isInitialized() && !freshStartApproved) return { kind: "needsSetup" };
    let runtime;
    const target = publishedRuntime(cfg);
    if (target && !existsSync(target)) onPhase("publishing");
    try { runtime = await deps.publish(); }
    catch (error) { return { kind: "failed", message: `准备自带运行时失败：${error.message}` }; }
    let lock;
    try {
      lock = await acquireStartLock(cfg.dataDir, {
        timeoutMs,
        until: async () => settle(await deps.probe()) ?? (activeHold(cfg) ? { kind: "failed", message: activeHold(cfg) } : null),
      });
    } catch (error) {
      return { kind: "failed", message: `无法取得服务启动锁：${error.message}` };
    }
    if (lock.settled) return lock.settled;
    if (lock.timeout) return { kind: "failed", message: "等另一处启动 Navi 服务超时。可以重试；服务起来后也会自动载入。" };
    try {
      const again = settle(await deps.probe());
      if (again) return again;
      hold = activeHold(cfg);
      if (hold) return { kind: "failed", message: hold };
      const missing = [join("node", cfg.nodeName), "server/dist/index.js"].map((part) => join(runtime, part)).find((file) => !existsSync(file));
      if (missing) return { kind: "failed", message: `自带的 Navi 不完整（缺 ${missing}）。重新装一次 Navi。` };
      try { mkdirSync(cfg.logsDir, { recursive: true }); }
      catch (error) { return { kind: "failed", message: `建不了日志目录 ${cfg.logsDir}：${error.message}` }; }
      let path = "";
      try { path = deps.registryPath(); } catch { /* 读不出注册表就用继承来的那份 */ }
      const env = serverEnvironment(cfg, { registryPath: path, allowOtherDevices: allowsOtherDevices(cfg) });
      const spawned = deps.spawn(runtime, env);
      deps.log(spawned.error ? `起服务失败：${spawned.error}` : `起了服务进程 ${spawned.pid}（Job：${spawned.job ?? "未知"}）`);
      if (spawned.error) return { kind: "failed", message: spawned.error };
      return await waitReady(spawned.pid, timeoutMs);
    } finally {
      lock.release();
    }
  }

  /** 等刚起的那个进程应答。它先退了、或者端口被别人抢先占上，都不必等满时限。 */
  async function waitReady(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await deps.probe();
      if (result.kind === "navi") {
        const why = mismatch(result.instance, cfg);
        if (!why) return { kind: "ready", instance: result.instance };
        if (result.instance.pid !== pid) return { kind: "occupied", message: otherNavi(result.instance) };
        return { kind: "failed", message: `服务进程 ${pid} 起来了，但${why}${windowPortNote(result.instance)}\n\n日志：${cfg.serverLog}` };
      }
      if (result.kind === "notNavi") return { kind: "occupied", message: notNavi(result.what) };
      if (!isPidAlive(pid)) {
        const taken = listenerNote(cfg.port, pid);
        if (taken) return { kind: "occupied", message: taken };
        return { kind: "failed", message: `服务进程 ${pid} 起来就退出了：\n${logTail(cfg)}\n\n完整日志：${cfg.serverLog}` };
      }
      await sleep(500);
    }
    return { kind: "failed", message: `服务进程 ${pid} 起了，但 ${Math.round(timeoutMs / 1000)} 秒内没应答 /api/health。看日志 ${cfg.serverLog}。` };
  }

  function windowPortNote(instance) {
    if (instance.windowPort === cfg.windowPort) return "";
    const who = describeListeners(safeListeners(cfg.windowPort));
    return who ? `\n\n窗口专用端口 ${cfg.windowPort} 上是：${who}。关掉它之后点「重试」。` : "";
  }

  function safeListeners(port) {
    try { return deps.listeners(port); } catch { return []; }
  }

  /** 服务退了、端口上却有人在听（不说 HTTP 的程序探活时只会超时）：说清是谁。 */
  function listenerNote(port, ownPid) {
    const others = safeListeners(port).filter((row) => row.pid !== ownPid);
    if (!others.length) return null;
    return `${port} 端口被别的程序占着（${describeListeners(others)}），Navi 服务起不来。\n\n关掉它之后点「重试」。`;
  }

  /** 「端口被占着」时说给用户听的那段话：是谁、怎么办。 */
  function otherNavi(instance) {
    const who = instance.pid ? `进程 ${instance.pid}` : "进程号不明";
    const lines = [`${cfg.port} 端口上已经有一份 Navi 在跑（${who}），但它不是这个 app 起的那份，所以没有连上去。${mismatch(instance, cfg) ?? ""}`];
    let checkout = false;
    if (instance.codeDir && instance.dataDir) {
      lines.push(`代码：${instance.codeDir}\n数据：${instance.dataDir}`);
      checkout = existsSync(join(instance.codeDir, ".git"));
      if (checkout) lines.push("这是仓库里起的开发实例（npm run restart）。");
    }
    const stop = checkout ? "在那个检出里跑 npm run stop"
      : instance.pid ? `任务管理器里结束进程 ${instance.pid}，或 taskkill /PID ${instance.pid} /T` : `netstat -ano | findstr :${cfg.port} 找到它再停`;
    lines.push(`要用 app：先停掉它（${stop}），再点「重试」。开发实例以后换个端口起，例如在 PowerShell 里 $env:PORT=14317; npm run restart。`);
    return lines.join("\n\n");
  }

  function notNavi(what) {
    const who = describeListeners(safeListeners(cfg.port));
    return `${cfg.port} 端口被别的程序占着（${who ? `${who}，` : ""}它应答了 ${what}，不是 Navi），Navi 服务起不来。\n\n`
      + (who ? "关掉它之后点「重试」。" : `看是谁：netstat -ano | findstr :${cfg.port}；关掉它之后点「重试」。`);
  }

  return {
    settle,
    isInitialized,
    approveFreshStart() { freshStartApproved = true; },
    /**
     * 确保服务在跑：自己那份通着就直接 ready；没通就起一个并等它应答。同时来的请求合成一次。
     * 这一版的运行时还没发布过时先报一声 onPhase("publishing")：第一次要把上万个文件拷过去再逐个校验，慢的机器上要几分钟。
     */
    ensureRunning(timeoutMs = 45_000, onPhase = () => {}) {
      if (!pending) pending = run(timeoutMs, onPhase).catch((error) => ({ kind: "failed", message: error.message })).finally(() => { pending = null; });
      return pending;
    },
  };
}

function describeListeners(rows) {
  return rows.map((row) => [`进程 ${row.pid}`, row.name, row.path && `（${row.path}）`].filter(Boolean).join(" ")).join("；");
}

function logTail(cfg) {
  try { return readFileSync(cfg.serverLog, "utf8").slice(-1200).trim() || "（日志是空的）"; }
  catch { return "（没有日志）"; }
}

/**
 * 校验自带运行时、发布到运行时仓库（已发布的校验后复用），返回发布目录。
 * 校验要把每个文件读一遍算 sha256，全是同步调用，放进 worker：控制器的事件循环得空着画「正在启动」、应答窗口。
 */
export function publishRuntime(cfg) {
  if (!publishedRuntime(cfg)) return Promise.reject(new Error(`${cfg.bundledRuntime} 里没有运行时清单，请重新安装 Navi。`));
  const workerData = {
    url: pathToFileURL(join(cfg.bundledRuntime, "scripts/runtime-store.mjs")).href,
    source: cfg.bundledRuntime,
    store: cfg.runtimeStore,
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      import(workerData.url)
        .then((store) => parentPort.postMessage({ target: store.installRuntime(workerData.source, workerData.store, { activate: false }) }))
        .catch((error) => parentPort.postMessage({ error: String(error?.message ?? error) }));
    `, { eval: true, workerData });
    worker.once("message", (answer) => (answer.error ? reject(new Error(answer.error)) : resolve(answer.target)));
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`发布运行时的线程退出了（${code}）`)));
  });
}

/**
 * 起服务进程，返回 { pid } 或 { error }。有壳（NAVI_WIN_SHELL）就交给壳的 `--spawn-detached`（脱离 Job，见文件头）；
 * 没有（回归测试、单独跑控制器）退回 scripts/start-detached.mjs。
 */
export function spawnServer(cfg, runtime, env) {
  const node = join(runtime, "node", cfg.nodeName);
  const entry = join(runtime, "server/dist/index.js");
  const [command, args] = cfg.shellExe
    ? [cfg.shellExe, ["--spawn-detached", cfg.serverLog, node, entry]]
    : [node, [join(runtime, "scripts/start-detached.mjs"), cfg.serverLog, node, entry]];
  const run = spawnSync(command, args, { cwd: cfg.dataDir, env, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (run.error) return { error: `拉不起服务：${run.error.message}` };
  const last = (run.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let report;
  try { report = cfg.shellExe ? JSON.parse(last) : { pid: Number(last) }; } catch { report = {}; }
  if (run.status === 0 && Number.isInteger(report.pid) && report.pid > 0) return { pid: report.pid, job: report.job ?? null };
  return { error: report.error ?? `启动命令失败（退出码 ${run.status}）：${`${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-1600)}` };
}
