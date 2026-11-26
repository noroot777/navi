// mac app 起服务那一步的定点回归（仅 macOS）：端口上一时没人应答，可这份库的单实例锁还握在一个活着的服务手里。
// 2026-11-26 实测：旧版 app 起的服务 3 次探活超时，启动器当成「没在跑」，切了运行时、做了备份、起了新版、
// 在它起来之前把服务记录改成新进程 —— 新版被旧服务的库锁挡下退出，旧服务十几秒后缓过来，记录却再也认不出
// 它是旧版，之后不会再提出切换。
//
// 编进测试驱动的是真的 ServerLauncher / ServerRecord / DatabaseBackup / UpdateGate（Tests/Update/main.swift）；
// 端口上摆一个假的「旧服务」（独立进程，像真 server 一样在数据根里写单实例锁，health 按文件答 ok / 不应答），
// 自带运行时是假的（node 就是跑测试的 node，server 几行：被锁挡下 / 起来就退）。
// 覆盖：锁的持有者活着、一时不应答 → 不起、等它缓过来、记录不变；端口关着也一样；等满时限 → 如实说是谁，
// 「停掉它」只停那一个、它缓过来就不停、不理 SIGTERM 时再给强制结束；起出来的那份没服务过就退了（被锁挡下 /
// 自己没起来 / 等满时限之后才退）→ 在服务的那一份一字不动、旧版照样认得出，这一次只记成一次没成的尝试（留的底
// 照常固定，这一版再起不重备）；旧服务在尝试之后应答 → 它的恢复点作废；尝试之前的一眼迟到了才交来确认 → 什么都
// 不改；闸在等着换掉旧服务时端口上已经是这一版起的那份 → 不再接管它。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_ENV_PREFIXES } from "./legacy-names.mjs";
import { withTestResources } from "./test-process-resources.mjs";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const mac = join(root, "desktop/macos");
const temporary = mkdtempSync(join(tmpdir(), "navi-macos-launch-held-"));
const data = join(temporary, "data");
const runtime = join(temporary, "runtime");
const binary = join(temporary, "update-tests");
const fakes = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const port = await freePort();
const windowPort = await freePort();
const lockFile = join(data, "navi.db.navi.lock");
const recordFile = join(data, ".mac-server.json");
const healthFile = join(temporary, "health.txt");
/** 旧服务的 /api/health 怎么答：ok / hang（不应答）。 */
const setHealth = (value) => writeFileSync(healthFile, value);
const impactFile = join(temporary, "impact.json");
const setImpact = (value) => writeFileSync(impactFile, JSON.stringify(value));
/** 新起的那一份怎么死：refuse（库锁被 holder.json 里那个进程拿着）/ crash / linger（不应答，过一会儿才退）。 */
const newServerMode = join(temporary, "new-server-mode.txt");
const holderFile = join(temporary, "holder.json");
/** 新起的那一份每起一次记一行 pid。 */
const spawned = join(temporary, "spawned.txt");
const spawnedPids = () => (existsSync(spawned) ? readFileSync(spawned, "utf8").split("\n").filter(Boolean).map(Number) : []);

// 假的自带运行时：布局同 bundle-runtime.mjs。新版 server 起来就退，按 newServerMode 决定怎么退。
mkdirSync(join(runtime, "node/bin"), { recursive: true });
mkdirSync(join(runtime, "scripts"), { recursive: true });
mkdirSync(join(runtime, "server/dist"), { recursive: true });
symlinkSync(process.execPath, join(runtime, "node/bin/node"));
copyFileSync(join(root, "scripts/start-detached.mjs"), join(runtime, "scripts/start-detached.mjs"));
writeFileSync(join(runtime, "server/dist/index.js"), `const fs=require('node:fs'),path=require('node:path');
fs.appendFileSync(${JSON.stringify(spawned)},process.pid+'\\n');
const mode=fs.readFileSync(${JSON.stringify(newServerMode)},'utf8');
if(mode==='linger'){setTimeout(()=>process.exit(1),3500);return;}
if(mode==='refuse'){
  // 它查过之后、这一份拿锁之前，旧服务把锁拿走了：这一份被挡下，一个字节没碰库。
  const holder=JSON.parse(fs.readFileSync(${JSON.stringify(holderFile)},'utf8'));
  fs.writeFileSync(path.join(process.env.NAVI_DATA_DIR,'navi.db.navi.lock'),JSON.stringify({version:1,...holder,token:'held'}));
  console.error('server.refused holderPid='+holder.pid);
}
process.exit(1);`);

const build = spawnSync("swiftc", ["-swift-version", "5",
  ...["BundleRuntimeUse", "NaviConfig", "NaviHealth", "RuntimeLog", "DataImport", "DatabaseBackup", "LegacyIdentity", "LoginService", "RestartImpact", "ServerControl", "ServerLauncher", "ServerStartLock", "UpdateGate", "RuntimeRecovery"]
    .map((name) => join(mac, `Sources/${name}.swift`)),
  join(mac, "Tests/Update/main.swift"), "-o", binary], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);

// 跑测试的这个进程自己带着的 app 配置（两代名字都算）不往下传。
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !new RegExp(`^(?:NAVI_|${LEGACY_ENV_PREFIXES[0]})(?:DATA_DIR|URL|LOCAL_ONLY|MAC_\\w+)$`).test(key)));
const env = { ...inherited, NAVI_URL: `http://127.0.0.1:${port}`, NAVI_DATA_DIR: data, NAVI_MAC_RUNTIME: runtime,
  NAVI_MAC_WINDOW_PORT: String(windowPort) };

/**
 * 假的旧服务：独立进程。`lock`：像真 server 一样在数据根里写单实例锁（pid + 启动时刻）；`listen`：听不听端口；
 * `stubborn`：不理 SIGTERM。返回子进程和它的启动时刻（ms）。
 */
async function startHolder({ lock = true, listen = true, stubborn = false } = {}) {
  const source = `
    const http = require('node:http'); const fs = require('node:fs');
    ${stubborn ? "process.on('SIGTERM', () => {});" : ""}
    const startedAt = Date.now() - process.uptime() * 1000;
    if (${lock}) fs.writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ version: 1, pid: process.pid,
      processStartedAtMs: startedAt, processStartedAt: new Date(startedAt).toISOString(), token: 'old' }));
    const ready = () => console.log(JSON.stringify({ startedAt }));
    if (!${listen}) { setInterval(() => {}, 1 << 30); ready(); }
    else http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/restart-impact')) return res.end(fs.readFileSync(${JSON.stringify(impactFile)}, 'utf8'));
      if (req.url === '/api/restart-freeze') { res.statusCode = 404; return res.end('{}'); }
      if (fs.readFileSync(${JSON.stringify(healthFile)}, 'utf8') === 'hang') return;
      res.end(JSON.stringify({ ok: true, pid: process.pid, instance: { id: 'old-' + process.pid, dataDir: ${JSON.stringify(data)},
        codeDir: ${JSON.stringify(runtime)}, localOnly: true, windowPort: ${windowPort} } }));
    }).listen(${port}, '127.0.0.1', ready);`;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "inherit"] });
  fakes.add(child);
  child.once("exit", () => fakes.delete(child));
  const [line] = await once(child.stdout, "data");
  return { child, pid: child.pid, startedAt: JSON.parse(String(line)).startedAt };
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

async function stop(holder) {
  if (alive(holder.child)) {
    holder.child.kill("SIGKILL");
    await once(holder.child, "exit");
  }
}

function driveAsync(args, answers = "") {
  const child = spawn(binary, args, { env: { ...env, ANSWERS: answers }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const done = new Promise((resolveDone) => child.once("close", (status) => resolveDone({ status, out })));
  return { done, output: () => out };
}
const drive = (args, answers) => driveAsync(args, answers).done;

const OLD = "20000101.0000";
const record = () => JSON.parse(readFileSync(recordFile, "utf8"));
const attempt = () => { const { pid, bundleVersion } = record().attempt; return { pid, bundleVersion }; };
const backups = () => (existsSync(join(data, "backups")) ? readdirSync(join(data, "backups")).filter((n) => n.endsWith(".db")) : []);
const pins = async () => (await drive(["pins"])).out.match(/PINS (.*)/)[1].split(",").filter(Boolean);
const staleness = async (pid) => (await drive(["staleness", String(pid)])).out.match(/STALE (.*)/)[1];
const reset = () => {
  for (const name of [recordFile, lockFile, spawned]) rmSync(name, { force: true });
  rmSync(join(data, "backups"), { recursive: true, force: true });
};

await withTestResources(async () => {
  // 数据根里一份真库（新版起之前要给它留底：这一次没留才说明没走到起服务那一步）。
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "navi.db"));
  db.exec("create table tasks (id text primary key); insert into tasks values ('t1')");
  db.close();
  setImpact({ survives: [], resumes: [], interrupted: [], mcpDisrupted: [] });

  // ── 旧服务一时不应答、锁的持有者活着：不起新的，等它缓过来；记录一字不动 ──
  reset();
  setHealth("ok");
  let holder = await startHolder();
  await drive(["record", String(holder.pid), OLD]);
  setHealth("hang");
  const waiting = driveAsync(["launch", "20"]);
  await delay(3500);
  assert.deepEqual(spawnedPids(), [], `no second server while the lock holder lives\n${waiting.output()}`);
  setHealth("ok");
  let result = await waiting.done;
  assert.match(result.out, /LAUNCH ready/, result.out);
  assert.deepEqual(spawnedPids(), []);
  assert.equal(record().pid, holder.pid);
  assert.equal(record().bundleVersion, OLD, "the record still says which build started the serving process");
  assert.equal(await staleness(holder.pid), OLD, "so a newer app still recognises it as stale");
  assert.deepEqual(backups(), [], "nothing was backed up: no launch was attempted");
  console.log("PASS: a lock holder that is slow to answer is waited for, not replaced; the service record is untouched");

  // ── 等满时限还不应答：如实说是谁；「停掉它」只停那一个，它缓过来了就不停，不理 SIGTERM 时再强制结束 ──
  await stop(holder);
  reset();
  setHealth("ok");
  holder = await startHolder({ stubborn: true });
  await drive(["record", String(holder.pid), OLD]);
  const before = readFileSync(recordFile, "utf8");
  setHealth("hang");
  result = await drive(["launch", "3"]);
  assert.match(result.out, new RegExp(`LAUNCH unresponsive ${holder.pid} .*进程 ${holder.pid}.*3 秒没在 \\d+ 端口上应答。没有另起一份`), result.out);
  assert.deepEqual(spawnedPids(), []);
  assert.equal(readFileSync(recordFile, "utf8"), before);
  assert.deepEqual(backups(), []);
  setHealth("ok");
  result = await drive(["stop-unresponsive", "term"]);
  assert.match(result.out, /STOP-HOLDER changed/, "it answers again: nothing to stop");
  assert.equal(alive(holder.child), true);
  setHealth("hang");
  result = await drive(["stop-unresponsive", "term"]);
  assert.match(result.out, /STOP-HOLDER stillRunning/, result.out);
  assert.equal(alive(holder.child), true, "a process that ignores SIGTERM is reported, not escalated on its own");
  result = await drive(["stop-unresponsive", "kill"]);
  assert.match(result.out, /STOP-HOLDER stopped/, result.out);
  await delay(100);
  assert.equal(alive(holder.child), false);
  console.log("PASS: after the timeout the holder is named; stopping it is the user's call, only that process, escalating only on request");

  // ── 锁的持有者活着、端口却关着（正在退出 / 还在起）：同样不起 ──
  reset();
  holder = await startHolder({ listen: false });
  result = await drive(["launch", "2"]);
  assert.match(result.out, new RegExp(`LAUNCH unresponsive ${holder.pid}`), result.out);
  assert.deepEqual(spawnedPids(), []);
  await stop(holder);
  console.log("PASS: a closed port with a live lock holder is not a reason to start another server either");

  // ── 起出来那份被锁挡下（锁在查过之后才被拿走）：在服务的那一份不动、旧版照样认得出，接着等它 ──
  reset();
  setHealth("hang");
  holder = await startHolder({ lock: false });
  writeFileSync(holderFile, JSON.stringify({ pid: holder.pid, processStartedAtMs: holder.startedAt }));
  writeFileSync(newServerMode, "refuse");
  await drive(["record", String(holder.pid), OLD]);
  result = await drive(["launch", "3"]);
  assert.equal(spawnedPids().length, 1, result.out);
  assert.match(result.out, new RegExp(`LAUNCH unresponsive ${holder.pid}`), "and then it waits for the holder instead\n" + result.out);
  assert.equal(record().pid, holder.pid, "the serving identity is untouched");
  assert.equal(record().bundleVersion, OLD);
  assert.deepEqual(attempt(), { pid: spawnedPids()[0], bundleVersion: "dev" }, "the spawn is only an attempt");
  assert.equal(await staleness(holder.pid), OLD, "the old service is still recognised as stale");
  assert.equal(backups().length, 1, "fixture: the launch backed up before spawning");
  assert.deepEqual(await pins(), backups(), "whether the attempt touched the database is not guessed: the backup stays pinned");
  await stop(holder);
  console.log("PASS: a spawn refused by the lock leaves the serving identity as it was");

  // ── 起出来那份等满时限都没应答、之后才退：同样只是一次没成的尝试；旧服务缓过来后再确认，那次尝试作废 ──
  reset();
  setHealth("hang");
  holder = await startHolder({ lock: false });
  writeFileSync(newServerMode, "linger");
  await drive(["record", String(holder.pid), OLD]);
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*2 秒内没应答/, result.out);
  const [lingering] = spawnedPids();
  for (let i = 0; i < 100 && spawnSync("kill", ["-0", String(lingering)]).status === 0; i++) await delay(100);
  assert.notEqual(spawnSync("kill", ["-0", String(lingering)]).status, 0, "fixture: the spawned server exited after the launcher gave up");
  assert.equal(record().pid, holder.pid);
  assert.equal(record().bundleVersion, OLD);
  assert.equal(await staleness(holder.pid), OLD, "an exit nobody waited for does not cost the old service its version");
  setHealth("ok");
  result = await drive(["launch", "5"]);
  assert.match(result.out, /LAUNCH ready/, result.out);
  assert.deepEqual(spawnedPids(), [lingering], "the recovered old service is adopted, nothing new is started");
  assert.equal(record().bundleVersion, OLD);
  assert.ok(record().confirmedAt > record().attempt.startedAt, "it was seen serving after the attempt");
  assert.deepEqual(await pins(), [], "so the database was last written by it: its points are released, the next build backs up afresh");
  assert.equal(await staleness(holder.pid), OLD);
  await stop(holder);
  console.log("PASS: a spawn that exits after the launcher stopped waiting is reconciled by the record itself");

  // ── 迟到的一眼：旧服务应答之后才退、新的一次已经起了，这一眼才交到确认那一处 —— 什么都不改 ──
  reset();
  setHealth("ok");
  holder = await startHolder({ lock: false });
  await drive(["record", String(holder.pid), OLD]);
  const go = join(temporary, "go");
  rmSync(go, { force: true });
  const observer = driveAsync(["observe", go]);
  for (let i = 0; i < 100 && !observer.output().includes("OBSERVED"); i++) await delay(50);
  assert.match(observer.output(), new RegExp(`OBSERVED ${holder.pid}`), observer.output());
  await stop(holder);
  writeFileSync(newServerMode, "linger");
  result = await drive(["launch", "2"]);
  assert.match(result.out, /LAUNCH failed .*2 秒内没应答/, result.out);
  const pending = record();
  assert.equal(pending.attempt.pid, spawnedPids()[0]);
  assert.deepEqual(await pins(), backups(), "fixture: the attempt's backup is pinned");
  writeFileSync(go, "");
  result = await observer.done;
  assert.match(result.out, /SETTLED ready/, result.out);
  assert.deepEqual(record(), pending, "an answer from before the attempt confirms nothing about after it");
  assert.deepEqual(await pins(), backups(), "and releases no recovery point");
  assert.equal(await staleness(holder.pid), OLD);
  for (let i = 0; i < 100 && spawnSync("kill", ["-0", String(spawnedPids()[0])]).status === 0; i++) await delay(100);
  console.log("PASS: a late observation of the old service does not undo a newer attempt or its recovery point");

  // ── 自己没起来（没人握着锁）：在服务的那一份不动；「这一版起过」记在尝试里，下一版起之前照常重备、这一版再起不重备 ──
  reset();
  writeFileSync(newServerMode, "crash");
  await drive(["record", "4242", OLD]);
  result = await drive(["launch", "3"]);
  assert.match(result.out, /LAUNCH failed .*起来就退出了/, result.out);
  assert.equal(spawnedPids().length, 1);
  assert.equal(record().pid, 4242, "no pid that never served becomes the serving identity");
  assert.equal(record().bundleVersion, OLD);
  assert.deepEqual(attempt(), { pid: spawnedPids()[0], bundleVersion: "dev" }, "this build had its go at the database");
  assert.deepEqual(await pins(), backups(), "the pre-migration backup stays pinned");
  assert.equal(backups().length, 1);
  result = await drive(["launch", "3"]);
  assert.match(result.out, /LAUNCH failed/, result.out);
  assert.equal(backups().length, 1, "the same build trying again needs no second backup");
  console.log("PASS: a server that exits on its own leaves only an attempt, not a serving identity");

  // ── 闸在等着换掉旧服务，端口上已经是这一版起的那份：不再接管、不停它 ──
  reset();
  setHealth("ok");
  holder = await startHolder();
  await drive(["record", String(holder.pid)]);
  result = await drive(["stale", "5"]);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /^(?:HOLD |RELEASE$|ASK )/m, result.out);
  assert.match(result.out, /PROCEED[\s\S]*PHASE idle/, result.out);
  assert.equal(alive(holder.child), true);
  await drive(["record", String(holder.pid), OLD]);
  setImpact({ survives: [], resumes: [], interrupted: [{ id: "a", title: "排队的任务", reason: "排队中" }], mcpDisrupted: [] });
  const stale = driveAsync(["stale", "15"], "wait");
  for (let i = 0; i < 100 && !stale.output().includes("ASK"); i++) await delay(50);
  assert.match(stale.output(), /ASK Navi 服务还在跑旧版/);
  await drive(["record", String(holder.pid)]); // 等着的时候旧服务换成了这一版起的那份
  result = await stale.done;
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PROCEED[\s\S]*PHASE idle/, result.out);
  assert.doesNotMatch(result.out, /^(?:HOLD |RELEASE$)/m, result.out);
  assert.equal(alive(holder.child), true, "the current build's service is never handed over again");
  await stop(holder);
  console.log("PASS: a pending stale-service switch is dropped once this build's service is the one answering");
}, [
  async () => { for (const child of fakes) child.kill("SIGKILL"); },
  () => { for (const pid of spawnedPids()) { try { process.kill(pid, "SIGKILL"); } catch {} } },
  () => rmSync(temporary, { recursive: true, force: true }),
]);
