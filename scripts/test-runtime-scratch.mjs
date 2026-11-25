// 冒烟/测试留下的临时东西，清理不能只挂在可能被强杀的那个进程上：
//   · 本机临时目录（desktop/shared/scratch.mjs）：属主不在了的由下一次同类运行收掉，属主活着的、刚建还没写属主的不动；
//   · 对端临时目录（desktop/windows/scripts/remote-scratch.mjs）：开发机先记账，终端会话、目录与进程分开结算，
//     全部核实才销账，没结清的留账、下一次替属主已经不在的那几条结算；读不出或缺字段的账只报、不碰对端；
//   · rexec 的调用方中止：不连网就按 130 返回（Ctrl-C 时 remote-smoke 靠它让对端整棵树跟着终端会话走）。
// 真机上的超时 / Ctrl-C / 被杀三种结局，见 desktop/windows/README.md「冒烟」一节的实测。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimScratch, processAlive, reclaimScratch } from "../desktop/shared/scratch.mjs";

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "navi-runtime-scratch-")));
process.env.NAVI_WIN_REMOTE_JOURNAL = join(temporary, "journal");
const { claim, cleanRemote, cleanupCommand, forget, journalDir, journalFile, reclaimPending, records, remember, track } =
  await import("../desktop/windows/scripts/remote-scratch.mjs");
const { rexec } = await import("./win-remote/transport.mjs");
const gone = () => spawnSync(process.execPath, ["-e", "0"]).pid;

try {
  // ── 本机临时目录 ─────────────────────────────────────────────────────────
  const parent = join(temporary, "tmp");
  mkdirSync(parent);
  const mine = claimScratch(parent, "navi-x-");
  const dead = join(parent, "navi-x-dead");
  mkdirSync(join(dead, "deep"), { recursive: true });
  writeFileSync(join(dead, ".navi-owner.json"), JSON.stringify({ pid: gone() }));
  const fresh = join(parent, "navi-x-fresh");
  mkdirSync(fresh);
  const old = join(parent, "navi-x-old");
  mkdirSync(old);
  utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  const other = join(parent, "someone-else");
  mkdirSync(other);
  assert.ok(processAlive(process.pid));
  assert.ok(!processAlive(gone()));
  const { removed, failed } = reclaimScratch(parent, "navi-x-");
  assert.deepEqual(removed.sort(), [dead, old].sort());
  assert.deepEqual(failed, []);
  assert.ok(existsSync(mine) && existsSync(fresh) && existsSync(other));
  console.log("✓ 本机临时目录：属主不在的、没属主且超过一小时的收掉；自己的、刚建的、别的前缀不动");

  // ── 对端临时目录的账本 ─────────────────────────────────────────────────────
  const command = cleanupCommand("0123456789ab");
  assert.match(command, /\$name = 'navi-win-runtime-0123456789ab'/);
  assert.match(command, /ROOT_GONE/);
  // 删目录不能交给 Remove-Item（5.1 删不了超过 260 字符的路径），要走 \\?\ 前缀。
  assert.ok(command.includes(String.raw`[IO.Directory]::Delete('\\?\' + $path, $true)`), "清理要能删长路径");
  assert.ok(!/Remove-Item -LiteralPath \$root/.test(command));
  // 进程表查不出来不能当成「一个都没有」。
  assert.match(command, /Get-CimInstance Win32_Process -ErrorAction Stop/);
  assert.match(command, /if \(\$script:queryError\) \{ Write-Output \("ROOT_LEFT /);

  const host = "http://example.invalid:4317";
  assert.throws(() => remember({ id: "../evil", host }), /不合规/);
  assert.throws(() => remember({ id: "eeeeeeeeeeee" }), /对端地址不合规/, "记账时就要定下目标机器");
  const mine2 = remember({ id: "aaaaaaaaaaaa", host });
  track(mine2, { projectId: "p0", sessionId: "s0" });
  assert.deepEqual(readdirSync(journalDir()).sort(), ["aaaaaaaaaaaa.json"], "写账本走临时文件加改名，不留临时文件");
  assert.deepEqual(records().find((r) => r.id === "aaaaaaaaaaaa").sessions, [{ projectId: "p0", sessionId: "s0" }]);

  const gonePid = gone();
  const write = (id, body) => writeFileSync(journalFile(id), typeof body === "string" ? body : JSON.stringify({ id, ...body }));
  writeFileSync(join(journalDir(), `ffffffffffff.json.${gonePid}.tmp`), "{\"id\":");
  writeFileSync(join(journalDir(), `ffffffffffff.json.${process.pid}.tmp`), "{\"id\":");
  write("bbbbbbbbbbbb", { owner: gonePid, host, sessions: [{ projectId: "p1", sessionId: "s1" }] });
  write("cccccccccccc", { owner: gonePid, host, sessions: [{ projectId: "p1", sessionId: "s2" }] });
  write("dddddddddddd", { owner: gonePid, host, sessions: [] });
  write("111111111111", { owner: process.ppid, host, sessions: [] });
  write("222222222222", "");                                               // 写到一半被读到（截断之后、写入之前）
  write("333333333333", { owner: gonePid, sessions: [] });                 // 缺目标机器
  write("444444444444", { owner: 0, host, sessions: [] });                 // 缺属主

  const calls = [];
  const replies = {
    bbbbbbbbbbbb: [{ code: 0, out: "ROOT_GONE C:\\T\\x existed=True killed=3\r\n", session: "c1" }],
    cccccccccccc: [{ code: 0, out: "ROOT_GONE C:\\T\\y existed=False killed=0", session: "c2" }],
    dddddddddddd: [new Error("connect EHOSTUNREACH"), { code: 1, out: "ROOT_LEFT C:\\T\\z 进程表查不出来：RPC" }],
  };
  const exec = async (cmd, options) => {
    const id = /navi-win-runtime-([a-f0-9]{12})/.exec(cmd)[1];
    calls.push({ id, host: options.host });
    const reply = replies[id].shift();
    if (reply instanceof Error) throw reply;
    if (reply.session) options.onSession({ projectId: "p1", sessionId: reply.session });
    return reply;
  };
  const closed = [];
  const closeSession = async (session) => {
    closed.push(session);
    if (session.sessionId === "s2") throw new Error("DELETE → 503");
  };
  const failures = await reclaimPending({ exec, closeSession, log: () => {}, attempts: 2, pause: 1 });

  assert.deepEqual(calls.map((call) => call.id).sort(), ["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd", "dddddddddddd"],
    "身份不明的、自己的、属主还活着的都不该碰对端");
  assert.ok(calls.every((call) => call.host === host), "清理要发到记账时的那台机器");
  assert.ok(closed.some((s) => s.sessionId === "s1" && s.host === host), "被 kill -9 的属主留下的终端会话要关掉");
  assert.ok(closed.some((s) => s.sessionId === "c1"), "清理请求自己的终端会话也要关掉");
  assert.equal(failures, 5, "c（会话没关掉）、d（目录没清掉）、三条身份不明的都算没结清");
  const left = Object.fromEntries(records().map((record) => [record.id, record]));
  assert.ok(!left.bbbbbbbbbbbb, "会话、目录都结清了才销账");
  assert.deepEqual(left.cccccccccccc?.sessions.map((s) => s.sessionId), ["s2"], "会话没关掉：目录清了也不销账，没关掉的会话留在账上");
  assert.ok(left.dddddddddddd && !left.dddddddddddd.unknown, "目录没清掉要留账");
  for (const id of ["222222222222", "333333333333", "444444444444"]) assert.ok(left[id]?.unknown, `${id} 应当身份未知、原样留着`);
  assert.ok(left.aaaaaaaaaaaa && left["111111111111"]);
  assert.ok(!existsSync(join(journalDir(), `ffffffffffff.json.${gonePid}.tmp`)), "写账本的进程已经不在了，它的临时文件删掉");
  assert.ok(existsSync(join(journalDir(), `ffffffffffff.json.${process.pid}.tmp`)), "还在写的临时文件不动");
  console.log("✓ 对端账本：会话、目录分开结算，全部核实才销账；会话没关掉、目录没清掉都留账；读不出或缺字段的记录只报不碰；清理发到记账时的机器");

  const verdictless = await cleanRemote({ id: "aaaaaaaaaaaa", host, sessions: [] }, { exec: async () => ({ code: 0, out: "done but no verdict" }), attempts: 1, pause: 1 });
  assert.equal(verdictless.ok, false, "没有 ROOT_GONE 那一行就不算清掉，哪怕退出码是 0");

  // ── 一条账同一时刻只有一个持有者 ───────────────────────────────────────────
  // 审查复现过：两个回收者同时结算同一条死账，各拿一份快照互相覆盖，后销账的把另一个新记上的会话一起丢了。
  process.env.NAVI_WIN_REMOTE_JOURNAL = join(temporary, "journal-claims");
  mkdirSync(journalDir(), { recursive: true });
  const deadOwner = gone();
  writeFileSync(journalFile("abababababab"), JSON.stringify({ id: "abababababab", owner: deadOwner, host, sessions: [] }));

  // 两个回收者拿着同一份快照认领：改名只成功一次，另一个拿到 null 走开。
  writeFileSync(journalFile("cdcdcdcdcdcd"), JSON.stringify({ id: "cdcdcdcdcdcd", owner: deadOwner, host, sessions: [] }));
  const snapshot = records().find((entry) => entry.id === "cdcdcdcdcdcd");
  const first = claim(snapshot);
  assert.equal(first.owner, process.pid);
  assert.equal(claim(snapshot), null, "同一条账不能被认领两次");
  forget(first);

  // 认领者自己又被杀了：留下的认领文件按文件名里的 pid 认出来，下一个回收者再认领、结清。
  writeFileSync(join(journalDir(), `efefefefefef.claim-${deadOwner}.json`), JSON.stringify({ id: "efefefefefef", owner: deadOwner, host, sessions: [{ projectId: "p", sessionId: "E" }] }));

  // A 认领了 abab、正卡在清理请求里；这时另一个进程（B）来回收，必须一条都不碰。
  let entered;
  let resume;
  const inExec = new Promise((done) => { entered = done; });
  const hold = new Promise((done) => { resume = done; });
  const closedByA = [];
  const reclaimA = reclaimPending({
    log: () => {}, attempts: 1, pause: 1,
    closeSession: async (session) => { closedByA.push(session.sessionId); },
    exec: async (cmd, options) => {
      const id = /navi-win-runtime-([a-f0-9]{12})/.exec(cmd)[1];
      options.onSession({ projectId: "p", sessionId: `A-${id}` });
      if (id === "abababababab") { entered(); await hold; }
      return { code: 0, out: "ROOT_GONE simulated" };
    },
  });
  await inExec;
  assert.ok(existsSync(join(journalDir(), `abababababab.claim-${process.pid}.json`)), "认领之后账在认领者名下");
  const rival = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { reclaimPending } = await import(${JSON.stringify(new URL("../desktop/windows/scripts/remote-scratch.mjs", import.meta.url).href)});
    const execs = [];
    const closed = [];
    const failures = await reclaimPending({
      log: () => {}, attempts: 1, pause: 1,
      closeSession: async (session) => { closed.push(session.sessionId); },
      exec: async (cmd) => { execs.push(/navi-win-runtime-([a-f0-9]{12})/.exec(cmd)[1]); return { code: 0, out: "ROOT_GONE b" }; },
    });
    console.log(JSON.stringify({ execs, closed, failures }));
  `], { encoding: "utf8", env: { ...process.env } });
  assert.equal(rival.status, 0, rival.stderr);
  // A 是一条一条结的：它卡在 abab 上时 efef 还没人认领，B 拿走 efef 是对的；A 正持有的 abab，B 一下都不能碰。
  assert.deepEqual(JSON.parse(rival.stdout.trim()), { execs: ["efefefefefef"], closed: ["E"], failures: 0 },
    "别的进程正持有的账另一个回收者不碰；认领者死了留下的认领文件，下一个回收者再认领、连账上的会话一起结清");
  resume();
  assert.equal(await reclaimA, 0, "轮到 efef 时它已经被 B 认领走了，A 跳过而不是报错");
  assert.deepEqual(readdirSync(journalDir()), [], "两条都结清了，账本空了");
  assert.deepEqual(closedByA, ["A-abababababab"], "A 只关了自己那条清理请求的会话");
  console.log("✓ 一条账同一时刻只有一个持有者：认领靠原子改名只成一次，别人正持有的不碰，认领者死了下一个再认领");

  // ── rexec 调用方中止 ───────────────────────────────────────────────────────
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await rexec("Write-Output hi", { host: "http://127.0.0.1:9", timeout: 60_000, signal: controller.signal });
  assert.equal(result.code, 130);
  assert.ok(result.aborted);
  assert.ok(Date.now() - started < 5_000, "已中止的调用不该再等期限");
  console.log("✓ rexec 调用方中止按 130 返回，不等期限");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
