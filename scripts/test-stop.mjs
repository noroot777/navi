#!/usr/bin/env node
// 回归 stop.mjs:它跟 restart.mjs 第 2 步共用同一套安全闸(server-control.mjs),这里钉的是
// 「停」这一侧的结论 —— 能停的停干净、端口安静才报成功;会打断任务或问不出判据时一根手指
// 都不动;--force 明说要停就不被挡。假 server 是真监听、真回 JSON 的执行域 fixture。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";
import { isPidAlive, localGet, isNotListening, sleep } from "./platform.mjs";
import { parseStopOptions, stopCommand, STOP_USAGE } from "./stop-options.mjs";
import { runTestProcess } from "./test-process.mjs";
import { spawnTestFixture } from "./test-process-scope.mjs";
import { withTestResources } from "./test-process-resources.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const STOP = join(REPO, "scripts", "stop.mjs");
const PORT = 14318;

// ── 参数 ──────────────────────────────────────────────────────────────────────
const defaults = { force: false, wait: false, pid: null, born: null, help: false };
assert.equal(stopCommand("--force"), "node scripts/stop.mjs --force");
assert.ok(STOP_USAGE.startsWith(`用法: ${stopCommand()} [选项]`));
assert.deepEqual(parseStopOptions([], {}), defaults);
for (const [flag, field, variable] of [["--force", "force", "FORCE"], ["--wait", "wait", "WAIT"]]) {
  assert.deepEqual(parseStopOptions([flag], {}), { ...defaults, [field]: true });
  assert.deepEqual(parseStopOptions([], { [variable]: "1" }), { ...defaults, [field]: true });
  assert.deepEqual(parseStopOptions([], { [variable]: "" }), defaults);
}
for (const flag of ["--help", "-h"]) assert.deepEqual(parseStopOptions([flag], {}), { ...defaults, help: true });
for (const args of [["--froce"], ["force"], ["--force=false"]]) assert.throws(() => parseStopOptions(args, {}));
// --pid:只结束那一个没应答的服务进程(升级的退回命令用;行为单测在 test-upgrade-units.mjs)。
assert.deepEqual(parseStopOptions(["--pid", "4242", "--born", "1700000000000"], {}), { ...defaults, pid: 4242, born: "1700000000000" });
assert.equal(parseStopOptions(["--pid", "4242", "--born", "w133000000000000000"], {}).born, "w133000000000000000");
for (const bad of ["abc", "1", "0", "-3", "12x"]) assert.throws(() => parseStopOptions(["--pid", bad, "--born", "1"], {}), /--pid/);
assert.throws(() => parseStopOptions(["--pid", "4242"], {}), /--born/, "只给号码不给出生时刻:认不出还是不是当初那一个");
assert.throws(() => parseStopOptions(["--pid", "4242", "--born", "Mon 1"], {}), /--born/);

const help = await runTestProcess(NPM, ["run", "stop", "--", "--help"], {
  ...NPM_SPAWN_OPTS, cwd: REPO, encoding: "utf8", timeout: 30_000,
});
assert.match(help.stdout, /--force/);
assert.match(help.stdout, /--wait/);
assert.doesNotMatch(help.stdout, /▶|✅/);
const invalid = await runTestProcess(process.execPath, [STOP, "--froce"], { cwd: REPO, encoding: "utf8", timeout: 10_000 }, 2);
assert.match(invalid.stderr, /--help/);
assert.doesNotMatch(invalid.stdout, /▶/);
console.log("✓ stop 参数兼容环境变量, npm run stop 透传选项, 错误参数在动手前中止");

const TMP = mkdtempSync(join(tmpdir(), "navi-stop-test-"));
const env = {
  ...process.env,
  HTTP_PROXY: "http://127.0.0.1:1",
  HTTPS_PROXY: "http://127.0.0.1:1",
  ALL_PROXY: "socks5://127.0.0.1:1",
  PORT: String(PORT),
  NAVI_LOG: join(TMP, "navi.log"),
  // 锁路径跟着 DB 走,指到临时目录,别读到本机真 navi 的那把锁。
  NAVI_DB: join(TMP, "ash.db"),
  FORCE: "",
  WAIT: "",
};

/**
 * 起一个假 server:`/api/restart-impact` 回 impact(null = 收下请求永不作答),其余回 health。
 * freeze 给了就认重启前冻结(判据里报 `restartFreeze: 1`),每次 POST /api/restart-freeze 记进 `<name>.freeze.log`:
 *   clean  冻住、快照是空的;续期带回一个随服务关掉的终端
 *   widen  冻住,快照里却多出一个还在起跑的
 *   grow   快照是空的,续期带回的此刻名单里多了一个(冻结冻不住的那种)
 *   busy   另一处正冻着(409)
 */
async function fakeServer(name, impact, freeze = null) {
  const script = join(TMP, `${name}.mjs`);
  const pidFile = join(TMP, `${name}.pid`);
  writeFileSync(script, `import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const impact = ${JSON.stringify(impact && freeze ? { ...impact, restartFreeze: 1 } : impact)};
const mode = ${JSON.stringify(freeze)};
const empty = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };
createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url?.startsWith("/api/restart-impact")) {
    if (impact === null) return;
    return send(200, impact);
  }
  if (mode && req.url === "/api/restart-freeze" && req.method === "POST") {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text || "{}");
      const what = body.release ? "release" : body.renew ? "renew" : "acquire";
      appendFileSync(${JSON.stringify(join(TMP, `${name}.freeze.log`))}, what + "\\n");
      if (what === "release") return send(200, { protocol: 1, released: true });
      if (what === "renew") {
        const late = mode === "grow" ? [{ id: "mid", title: "冻结之后才冒出来的任务", reason: "进程已经不在了" }] : [];
        const resources = mode === "clean" ? [{ kind: "terminal", id: "t1", label: "终端 zsh" }] : [];
        return send(200, { protocol: 1, valid: true, expiresInMs: 30000, impact: { ...empty, interrupted: late, shutdown: { version: 1, resources } } });
      }
      if (mode === "busy") return send(409, { protocol: 1, error: "正在切换新版服务" });
      const interrupted = mode === "widen" ? [{ id: "late", title: "冻结时才看到的任务", reason: "正在起跑,还没交给重启后接得回的进程" }] : [];
      send(200, { protocol: 1, lease: "lease-" + mode, instance: "i", pid: process.pid, revision: 1, expiresInMs: 30000,
        impact: { ...empty, interrupted, shutdown: { version: 1, resources: [] } } });
    });
    return;
  }
  send(200, { ok: true, pid: process.pid });
}).listen(${PORT}, "127.0.0.1", () => writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
`);
  const fixture = spawnTestFixture(process.execPath, [script], { stdio: "ignore" });
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100);
  assert.ok(existsSync(pidFile), `${name}: 假 server 没起来`);
  const freezeLog = join(TMP, `${name}.freeze.log`);
  const freezeCalls = () => (existsSync(freezeLog) ? readFileSync(freezeLog, "utf8").split("\n").filter(Boolean).join(",") : "");
  return { fixture, pid: Number(readFileSync(pidFile, "utf8").trim()), freezeCalls };
}

const stop = (args, expected, extraEnv = {}) => runTestProcess(process.execPath, [STOP, ...args], {
  cwd: REPO, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000,
}, expected).then((r) => (r.stdout ?? "") + (r.stderr ?? ""));
const quiet = async () => isNotListening((await localGet(PORT, "/api/health", 1000)).error);
const EMPTY = { survives: [], resumes: [], interrupted: [], mcpDisrupted: [] };

await withTestResources(async () => {
  // 端口上本来就没人:直接说无需停止,退出 0。
  assert.ok(await quiet(), `:${PORT} 被别的东西占着,这条回归没法测`);
  const idle = await stop([], 0);
  assert.match(idle, /无需停止/);

  // 能停:停干净、端口安静、才报成功。
  const plain = await fakeServer("plain", EMPTY);
  await withTestResources(async () => {
    const out = await stop([], 0);
    assert.match(out, /已停止/, out);
    for (let i = 0; i < 25 && isPidAlive(plain.pid); i++) await sleep(40);
    assert.ok(!isPidAlive(plain.pid), `报了已停止,进程却还在\n${out}`);
    assert.ok(await quiet(), `报了已停止,端口却还被占着\n${out}`);
    assert.match(out, /没有重启前冻结/, `老服务不认冻结时要如实说问完到停下之间新起的任务不在名单上\n${out}`);
  }, [() => plain.fixture.dispose()]);
  console.log("✓ 没在跑时报无需停止; 在跑时停干净且端口安静才报成功");

  // 重启前冻结(server/src/restart-freeze.ts):过了闸先冻结,凭冻结之下的快照再判,下刀前续期核对。
  for (const [mode, line, calls] of [
    ["widen", /停止会打断 1 个任务[\s\S]*冻结时才看到的任务/, "acquire,release"],
    ["grow", /冻结之后又多了 1 个会被挡下的任务[\s\S]*冻结之后才冒出来的任务/, "acquire,renew,release"],
    ["busy", /冻结不了接活\(正在切换新版服务\)/, "acquire"],
  ]) {
    const server = await fakeServer(`freeze-${mode}`, EMPTY, mode);
    await withTestResources(async () => {
      const out = await stop([], 2);
      assert.match(out, line, out);
      assert.equal(server.freezeCalls(), calls, `${mode}: 冻结调用不对(中止时要放掉冻结,冻不了就只问那一次)\n${out}`);
      assert.ok(isPidAlive(server.pid), `${mode}: 中止时不许动它\n${out}`);
      assert.doesNotMatch(out, /已停止|没有重启前冻结/, out);
    }, [() => server.fixture.dispose()]);
  }
  // --wait:冻结之下才看得到的(即时判据一直是空的)放开再等,隔一会儿再冻;等待上限管整次操作,不是每轮从头算。
  const sticky = await fakeServer("freeze-sticky", EMPTY, "widen");
  await withTestResources(async () => {
    const started = Date.now();
    const out = await stop(["--wait"], 3, { WAIT_TIMEOUT: "6" });
    const took = Date.now() - started;
    assert.match(out, /WAIT 超时\(6s\),冻结之下仍有 1 个会被挡下[\s\S]*冻结时才看到的任务/, out);
    assert.equal(sticky.freezeCalls(), "acquire,release,acquire,release", `每轮都放掉冻结、隔一会儿才再冻,到了截止不再冻\n${out}`);
    assert.ok(took < 9000, `等待上限 6s,却跑了 ${took}ms\n${out}`);
    assert.ok(isPidAlive(sticky.pid), out);
  }, [() => sticky.fixture.dispose()]);
  const clean = await fakeServer("freeze-clean", EMPTY, "clean");
  await withTestResources(async () => {
    const out = await stop([], 0);
    assert.match(out, /已停止/, out);
    assert.equal(clean.freezeCalls(), "acquire,renew", `冻结 → 下刀前续期,停成了不再放\n${out}`);
    assert.match(out, /会随服务一起关掉 1 个:终端 zsh/, out);
    assert.doesNotMatch(out, /没有重启前冻结/, out);
    for (let i = 0; i < 25 && isPidAlive(clean.pid); i++) await sleep(40);
    assert.ok(!isPidAlive(clean.pid) && await quiet(), out);
  }, [() => clean.fixture.dispose()]);
  console.log("✓ 重启前冻结:快照或续期时多出来的拦住并放掉冻结、冻结被占就中止、--wait 的上限管到冻结后的重试、干净的续期后停;老服务如实退回");

  // 会打断任务:默认中止、不动它;--force 照停。
  const busy = await fakeServer("busy", { ...EMPTY, interrupted: [{ title: "接管不了的任务", reason: "测试" }] });
  await withTestResources(async () => {
    const blocked = await stop([], 2);
    assert.match(blocked, /停止会打断 1 个任务/, blocked);
    assert.ok(blocked.includes(stopCommand("--force")), blocked);
    assert.ok(isPidAlive(busy.pid), `会打断任务时不许动它\n${blocked}`);
    assert.doesNotMatch(blocked, /已停止/);
    const forced = await stop(["--force"], 0);
    assert.match(forced, /FORCE:打断 1 个/, forced);
    assert.match(forced, /已停止/, forced);
    assert.ok(await quiet(), forced);
  }, [() => busy.fixture.dispose()]);
  console.log("✓ 会打断任务时默认中止且不动进程, --force 照停");

  // 判据问不出来(在端口上却不答):中止、说清成因、不动它。
  const mute = await fakeServer("mute", null);
  await withTestResources(async () => {
    const out = await stop([], 2);
    assert.match(out, /问不到「停止会打断谁」/, out);
    assert.match(out, /没答复这条判据/, out);
    assert.ok(isPidAlive(mute.pid), `问不出判据时不许动它\n${out}`);
  }, [() => mute.fixture.dispose()]);
  console.log("✓ 判据问不出来时 fail closed, 不动旧进程");
}, [() => rmSync(TMP, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 })]);
