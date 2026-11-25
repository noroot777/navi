// 冒烟/测试留下的临时东西，清理不能只挂在可能被强杀的那个进程上：
//   · 本机临时目录（desktop/shared/scratch.mjs）：属主不在了的由下一次同类运行收掉，属主活着的、刚建还没写属主的不动；
//   · 对端临时目录（desktop/windows/scripts/remote-scratch.mjs）：开发机先记账、事后另发请求清理并核实，核实了才销账，
//     清不掉账留着，下一次替属主已经不在的那几条清；
//   · rexec 的调用方中止：不连网就按 130 返回（Ctrl-C 时 remote-smoke 靠它让对端整棵树跟着终端会话走）。
// 真机上的超时 / Ctrl-C / 被杀三种结局，见 desktop/windows/README.md「冒烟」一节的实测。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimScratch, processAlive, reclaimScratch } from "../desktop/shared/scratch.mjs";

const temporary = realpathSync(mkdtempSync(join(tmpdir(), "navi-runtime-scratch-")));
process.env.NAVI_WIN_REMOTE_JOURNAL = join(temporary, "journal");
const { cleanRemote, cleanupCommand, journalFile, reclaimPending, records, remember, remoteRootName } =
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
  assert.throws(() => remember({ id: "../evil" }), /不合规/);

  const calls = [];
  const fake = (replies) => async (cmd, options) => {
    calls.push(options);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const gonePid = gone();
  const write = (id, owner, host, session) => writeFileSync(journalFile(id), JSON.stringify({ id, owner, host, session }));
  const closed = [];

  remember({ id: "aaaaaaaaaaaa" });
  write("bbbbbbbbbbbb", gonePid, "http://example.invalid:4317", { projectId: "p1", sessionId: "s1" });
  write("cccccccccccc", gonePid);
  write("dddddddddddd", process.ppid);
  const failures = await reclaimPending({
    exec: fake([
      { code: 0, out: `ROOT_GONE C:\\T\\${remoteRootName("bbbbbbbbbbbb")} existed=True killed=3\r\n` },
      new Error("connect EHOSTUNREACH"),
      { code: 1, out: "ROOT_LEFT C:\\T\\x exists=True procs=12 node.exe" },
    ]),
    closeSession: async (session) => { closed.push(session); },
    log: () => {}, attempts: 2, pause: 1,
  });
  assert.deepEqual(closed, [{ projectId: "p1", sessionId: "s1", host: "http://example.invalid:4317" }], "被 kill -9 的属主留下的终端会话要先删掉");
  assert.equal(failures, 1);
  assert.equal(calls[0].host, "http://example.invalid:4317", "清理要发到记账时的那台机器");
  assert.equal(calls.length, 3, "清不掉的要重试");
  assert.deepEqual(records().map((record) => record.id).sort(), ["aaaaaaaaaaaa", "cccccccccccc", "dddddddddddd"]);
  console.log("✓ 对端账本：属主不在的才替它清（先删它留下的终端会话），核实 ROOT_GONE 才销账；连不上或 ROOT_LEFT 重试后账留着；自己的、属主还活着的不碰");

  const left = await cleanRemote("aaaaaaaaaaaa", { exec: fake([{ code: 0, out: "done but no verdict" }]), attempts: 1, pause: 1 });
  assert.equal(left.ok, false, "没有 ROOT_GONE 那一行就不算清掉，哪怕退出码是 0");

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
