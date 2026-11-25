// Windows 桌面壳的控制器（desktop/windows/launcher/）里不依赖 Windows 就能验的那些（在 mac 上也跑）：
//   · 配置：一切从 LOCALAPPDATA 派生，窗口专用端口按数据根算（Windows 上不分大小写），几个环境变量口子；
//   · 认人：health 的四种结果，mismatch 每一条判据；
//   · navi:// 链接：规则同 mac 的 DeepLink.swift；
//   · 登录项（假注册表）、交给服务的环境、启动锁、维护标记；
//   · 起服务：假运行时（封成 format 2）里放一个假服务，真发布、真按 start-detached 拉起，认人、复用、并发合一、
//     端口被别的 Navi / 别的程序占着时说清楚且不起。
// 控制器和壳之间那一来一回见 test-windows-shell-controller.mjs；真窗口、Job、注册表见 desktop/windows/scripts/shell-check.mjs。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sealRuntime } from "../desktop/shared/runtime-store.mjs";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { hashedPort, loadConfig, publishedRuntime } from "../desktop/windows/launcher/config.mjs";
import { decideLink, parseLink } from "../desktop/windows/launcher/deep-link.mjs";
import { classify, mismatch, probe } from "../desktop/windows/launcher/health.mjs";
import { createLauncher } from "../desktop/windows/launcher/launcher.mjs";
import { createLoginItem, pointsAt } from "../desktop/windows/launcher/login-item.mjs";
import { activeHold, beginMaintenance } from "../desktop/windows/launcher/maintenance.mjs";
import { mergePath, serverEnvironment } from "../desktop/windows/launcher/server-env.mjs";
import { acquireStartLock, tryStartLock } from "../desktop/windows/launcher/start-lock.mjs";
import { fakeRuntime, freePort, listen } from "./windows-shell-fixture.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
reclaimScratch(tmpdir(), "navi-windows-shell-");
const temporary = realpathSync(claimScratch(tmpdir(), "navi-windows-shell-"));
const started = new Set();
const servers = [];

try {
  // ── 配置 ─────────────────────────────────────────────────────────────────
  {
    const lad = join(temporary, "cfg");
    const win = loadConfig({ LOCALAPPDATA: lad }, "win32");
    assert.equal(win.baseURL, "http://127.0.0.1:4317");
    assert.equal(win.port, 4317);
    assert.ok(win.isLocal);
    assert.equal(win.nodeName, "node.exe");
    assert.equal(win.windowURL, `http://127.0.0.1:${win.windowPort}`);
    assert.ok(win.windowPort >= 42_000 && win.windowPort < 48_000);
    assert.equal(hashedPort("C:\\Users\\Me\\Data", true), hashedPort("c:\\users\\me\\data", true), "Windows 上换个大小写不该换端口");
    assert.notEqual(hashedPort("/Users/Me/Data", false), hashedPort("/users/me/data", false));
    // 算法与 mac 的 NaviConfig.windowPort 相同（FNV-1a），这个值两边要对得上。
    assert.equal(hashedPort("/Users/fjh/Library/Application Support/Navi", false), hashedPort("/Users/fjh/Library/Application Support/Navi", false));
    const custom = loadConfig({ LOCALAPPDATA: temporary, NAVI_URL: "http://127.0.0.1:14977", NAVI_WIN_WINDOW_PORT: "43001", NAVI_DATA_DIR: join(temporary, "d") }, "win32");
    assert.equal(custom.port, 14977);
    assert.equal(custom.windowPort, 43001);
    assert.equal(custom.dataDir, join(temporary, "d"));
    const remote = loadConfig({ LOCALAPPDATA: temporary, NAVI_URL: "http://mbp.tail.ts.net:4317" }, "win32");
    assert.equal(remote.isLocal, false);
    assert.equal(remote.windowURL, "http://mbp.tail.ts.net:4317", "连别处时窗口直接载那个地址");
    assert.throws(() => loadConfig({}, "win32"), /LOCALAPPDATA/);
    console.log("✓ 配置从 LOCALAPPDATA 派生，窗口端口按数据根算、不分大小写，环境变量口子生效");
  }

  // ── 认人 ─────────────────────────────────────────────────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "who") }, process.platform);
    mkdirSync(cfg.dataDir, { recursive: true });
    const body = (instance) => JSON.stringify({ ok: true, pid: 42, instance });
    const own = { id: "i1", dataDir: cfg.dataDir, codeDir: cfg.bundledRuntime, desktop: true, windowPort: cfg.windowPort, localOnly: true, tag: "ABCD-1234" };
    assert.equal(classify(404, "nope").kind, "notNavi");
    assert.equal(classify(200, JSON.stringify({ ok: false })).kind, "notNavi");
    const parsed = classify(200, body(own));
    assert.equal(parsed.kind, "navi");
    assert.equal(parsed.instance.pid, 42);
    assert.equal(mismatch(parsed.instance, cfg), null);
    assert.match(mismatch(classify(200, JSON.stringify({ ok: true, pid: 1 })).instance, cfg), /认不出来历/);
    assert.match(mismatch({ ...own, dataDir: join(temporary, "elsewhere") }, cfg), /另一份数据/);
    assert.match(mismatch({ ...own, codeDir: join(temporary, "checkout") }, cfg), /不是 app 自带的代码/);
    assert.match(mismatch({ ...own, desktop: false }, cfg), /不是 app 起的那一份/);
    assert.match(mismatch({ ...own, windowPort: 1 }, cfg), new RegExp(`专用端口 ${cfg.windowPort}`));
    const port = await freePort();
    assert.deepEqual(await probe(`http://127.0.0.1:${port}`), { kind: "down" });
    console.log("✓ 认人：四种探活结果，数据根 / 代码 / 桌面版标记 / 窗口端口逐条判");
  }

  // ── navi:// 链接 ─────────────────────────────────────────────────────────
  {
    const link = parseLink("navi://open?project=p1&task=t_2&instance=ABCD-12EF&fallback=" + encodeURIComponent("http://mbp:4317/?project=p1&task=t_2"));
    assert.deepEqual(link, { route: "/?project=p1&task=t_2", instance: "ABCD-12EF", fallback: "http://mbp:4317/?project=p1&task=t_2" });
    assert.equal(parseLink("NAVI://OPEN?project=p1").route, "/?project=p1", "scheme 与 host 不分大小写");
    for (const bad of ["navi://other?project=p", "navi://open?task=t", "navi://open?project=a/b", "navi://open?project=p&instance=x",
      "navi://open?project=p&fallback=javascript:alert(1)", "navi://open?project=p&task=t&fallback=" + encodeURIComponent("http://x/?project=p&task=other"),
      "https://open?project=p", "not a url"]) {
      assert.equal(parseLink(bad), null, bad);
    }
    assert.deepEqual(decideLink(link, "ABCD-12EF"), { kind: "window", route: link.route });
    assert.deepEqual(decideLink(link, "FFFF-0000"), { kind: "browser", url: link.fallback }, "指纹对不上交给浏览器");
    assert.deepEqual(decideLink(link, null), { kind: "browser", url: link.fallback }, "没认出自家服务也交给浏览器");
    assert.deepEqual(decideLink(parseLink("navi://open?project=p"), "ABCD-12EF"), { kind: "window", route: "/?project=p" }, "不带指纹的在自家窗口开");
    assert.deepEqual(decideLink(parseLink("navi://open?project=p&instance=ABCD-12EF"), null), { kind: "front" });
    console.log("✓ navi:// 只认 project / task / 指纹 / 同任务的 fallback；指纹对上进窗口，对不上交给浏览器");
  }

  // ── 登录项（假注册表） ───────────────────────────────────────────────────
  {
    const lad = join(temporary, "login");
    const installed = join(lad, "Programs", "Navi", "Navi.exe");
    const cfg = loadConfig({ LOCALAPPDATA: lad, NAVI_WIN_SHELL: installed }, "win32");
    let registry = { command: null, approvedFlag: null };
    const io = { read: () => registry, write: (command) => { registry = { command, approvedFlag: null }; } };
    const item = createLoginItem(cfg, io);
    assert.equal(item.isEnabled(), false);
    assert.equal(item.reconcileAtLaunch(), "enabled", "装好后第一次打开默认开上");
    assert.equal(registry.command, `"${installed}" --start-server`);
    assert.equal(item.reconcileAtLaunch(), "kept");
    item.setEnabled(false);
    assert.equal(registry.command, null);
    assert.equal(item.reconcileAtLaunch(), "kept", "用户关掉过就不再替他打开");
    item.setEnabled(true);
    registry = { command: `"C:\\Old\\Navi.exe" --start-server`, approvedFlag: 2 };
    assert.equal(item.reconcileAtLaunch(), "moved", "开着但 exe 换了位置：重写");
    assert.ok(pointsAt(registry.command, installed));
    registry = { command: `"C:\\Old\\Navi.exe" --start-server`, approvedFlag: 3 };
    assert.equal(item.isEnabled(), false, "任务管理器里停用了按「没开」显示");
    assert.equal(item.reconcileAtLaunch(), "kept", "停用的不重写（会把停用标记清掉）");
    assert.equal(createLoginItem(loadConfig({ LOCALAPPDATA: lad, NAVI_WIN_SHELL: "C:\\Downloads\\Navi\\Navi.exe" }, "win32"), io).reconcileAtLaunch(), "skipped", "解压目录不登记");
    assert.ok(pointsAt(`"c:/users/ME/appdata/local/programs/navi/navi.exe" --start-server`, "C:\\Users\\me\\AppData\\Local\\Programs\\Navi\\Navi.exe"), "引号、大小写、斜杠方向都不计较");
    assert.ok(pointsAt(`C:\\Navi\\Navi.exe --start-server`, "C:\\Navi\\Navi.exe"));
    assert.ok(!pointsAt(`"C:\\Navi\\Navi.exe.bak" --start-server`, "C:\\Navi\\Navi.exe"));
    console.log("✓ 登录项：首次默认开、尊重关掉、换位置重写、任务管理器停用的不动、解压目录不登记");
  }

  // ── 交给服务的环境 ───────────────────────────────────────────────────────
  {
    const cfg = loadConfig({ LOCALAPPDATA: temporary, NAVI_URL: "http://127.0.0.1:14977" }, "win32");
    const env = serverEnvironment(cfg, {
      inherited: { PATH: "C:\\old;C:\\Windows\\", path: "C:\\dup", NAVI_WIN_SHELL: "x", ASH_DATA_DIR: "C:\\stale", harness_data_dir: "y", Port: "1", USERPROFILE: "C:\\Users\\me" },
      registryPath: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm",
      allowOtherDevices: false,
    });
    const keys = Object.keys(env);
    assert.equal(keys.filter((key) => key.toUpperCase() === "PATH").length, 1, "PATH 只留一份");
    assert.ok(env.Path.startsWith("C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm"), "注册表那份在前");
    assert.ok(!/NAVI_WIN_|ASH_DATA_DIR|HARNESS_DATA_DIR/i.test(keys.join(",")));
    assert.equal(env.PORT, "14977");
    assert.equal(keys.filter((key) => key.toUpperCase() === "PORT").length, 1);
    assert.equal(env.NAVI_DESKTOP_APP, "1");
    assert.equal(env.NAVI_LOCAL_ONLY, "1");
    assert.equal(env.NAVI_WINDOW_PORT, String(cfg.windowPort));
    assert.equal(env.USERPROFILE, "C:\\Users\\me");
    const open = serverEnvironment(loadConfig({ LOCALAPPDATA: temporary }, "win32"), { inherited: { PORT: "9" }, allowOtherDevices: true });
    assert.equal(open.NAVI_LOCAL_ONLY, "0", "放开时写 0，不是不写");
    assert.equal(open.PORT, undefined, "默认端口不传 PORT");
    assert.equal(mergePath("A;b\\", "B;c", true), "A;b\\;c");
    console.log("✓ 服务环境：注册表 PATH 在前且只留一份，app 定的几样写死，壳的变量和旧名数据根清掉");
  }

  // ── 启动锁、维护标记 ─────────────────────────────────────────────────────
  {
    const dir = join(temporary, "lock");
    const release = tryStartLock(dir);
    assert.ok(release);
    assert.equal(tryStartLock(dir), null, "拿着的时候第二处拿不到");
    let calls = 0;
    const settled = await acquireStartLock(dir, { timeoutMs: 5_000, pause: 10, until: async () => (++calls === 3 ? { kind: "ready" } : null) });
    assert.deepEqual(settled, { settled: { kind: "ready" } }, "等锁时别处先起好了就直接用结论");
    assert.deepEqual(await acquireStartLock(dir, { timeoutMs: 50, pause: 10 }), { timeout: true });
    release();
    const again = await acquireStartLock(dir, { timeoutMs: 50 });
    assert.ok(again.release);
    again.release();

    const cfg = loadConfig({ LOCALAPPDATA: join(temporary, "maint") }, process.platform);
    mkdirSync(cfg.dataDir, { recursive: true });
    const end = await beginMaintenance(cfg, "正在重启", 1_000);
    assert.equal(activeHold(cfg), "正在重启");
    assert.equal(tryStartLock(cfg.dataDir), null, "维护期攥着启动锁");
    end();
    assert.equal(activeHold(cfg), null);
    writeFileSync(join(cfg.dataDir, ".win-maintenance.json"), JSON.stringify({ pid: 2 ** 22 + 7, note: "旧的", since: Date.now() }));
    assert.equal(activeHold(cfg), null, "持有者不在了的标记作废");
    assert.ok(!existsSync(join(cfg.dataDir, ".win-maintenance.json")));
    console.log("✓ 启动锁互斥、等锁时认别处的结论、超时；维护标记随持有者作废");
  }

  // ── 起服务（假运行时、真发布、真拉起） ───────────────────────────────────
  {
    const runtime = fakeRuntime(join(temporary, "bundle", "runtime"), repo);
    sealRuntime(runtime, { platform: "win32" });
    const port = await freePort();
    const lad = join(temporary, "launch");
    const env = { LOCALAPPDATA: lad, NAVI_URL: `http://127.0.0.1:${port}`, NAVI_WIN_RUNTIME: runtime, NAVI_WIN_WINDOW_PORT: String(await freePort()) };
    const cfg = loadConfig(env, process.platform);
    const launcher = createLauncher(cfg);
    assert.deepEqual(await launcher.ensureRunning(5_000), { kind: "needsSetup" }, "数据根还空着时不起");
    assert.ok(!existsSync(cfg.runtimeStore), "也不发布");
    launcher.approveFreshStart();
    const phases = [];
    const [first, second] = await Promise.all([
      launcher.ensureRunning(20_000, (phase) => phases.push(phase)),
      launcher.ensureRunning(20_000, (phase) => phases.push(`second:${phase}`)),
    ]);
    assert.equal(first, second, "同时来的请求合成一次");
    assert.equal(first.kind, "ready", JSON.stringify(first));
    started.add(first.instance.pid);
    assert.deepEqual(phases, ["publishing"], "第一次要发布时报一声，只报给发起的那一处");
    assert.ok(existsSync(publishedRuntime(cfg)), "发布到了运行时仓库");
    const seen = JSON.parse(readFileSync(join(cfg.dataDir, "fake-env.json"), "utf8"));
    assert.equal(seen.NAVI_DATA_DIR, cfg.dataDir);
    assert.equal(seen.NAVI_DESKTOP_APP, "1");
    assert.equal(seen.NAVI_LOCAL_ONLY, "1");
    assert.equal(seen.PORT, String(port));
    assert.equal(realpathSync(seen.codeDir), realpathSync(publishedRuntime(cfg)), "服务从发布目录跑，不从安装目录跑");
    const reused = await launcher.ensureRunning(5_000, (phase) => phases.push(phase));
    assert.equal(reused.kind, "ready");
    assert.equal(reused.instance.pid, first.instance.pid, "在跑就直接用，不另起");
    assert.deepEqual(phases, ["publishing"]);
    console.log("✓ 起服务：空数据根先问、发布后从发布目录起、认人通过、并发合一、在跑就复用");

    // 端口被别的 Navi（另一份数据）占着：不起，说清楚是谁、怎么停
    const foreignPort = await freePort();
    servers.push(await listen(foreignPort, (_req, res) => res.end(JSON.stringify({
      ok: true, pid: 4242, instance: { id: "x", dataDir: "C:\\other", codeDir: repo, desktop: false, windowPort: null },
    }))));
    const foreign = createLauncher(loadConfig({ ...env, NAVI_URL: `http://127.0.0.1:${foreignPort}` }, process.platform));
    const occupied = await foreign.ensureRunning(5_000);
    assert.equal(occupied.kind, "occupied");
    assert.match(occupied.message, /已经有一份 Navi 在跑（进程 4242）/);
    assert.match(occupied.message, /另一份数据/);
    assert.match(occupied.message, /npm run stop/, "仓库里起的开发实例：告诉人在检出里停");
    assert.match(occupied.message, /\$env:PORT=14317; npm run restart/);

    // 端口被不说 Navi 话的程序占着
    const otherPort = await freePort();
    servers.push(await listen(otherPort, (_req, res) => { res.writeHead(404); res.end("nope"); }));
    const other = await createLauncher(loadConfig({ ...env, NAVI_URL: `http://127.0.0.1:${otherPort}` }, process.platform)).ensureRunning(5_000);
    assert.equal(other.kind, "occupied");
    assert.match(other.message, new RegExp(`${otherPort} 端口被别的程序占着.*HTTP 404`, "s"));

    // 连别处的地址不替它起
    const far = await createLauncher(loadConfig({ ...env, NAVI_URL: "http://192.0.2.1:9" }, process.platform)).ensureRunning(5_000);
    assert.ok(["failed"].includes(far.kind));

    // 服务起来就退了：带上日志末尾
    const brokenRuntime = fakeRuntime(join(temporary, "broken", "runtime"), repo, { crash: true });
    sealRuntime(brokenRuntime, { platform: "win32" });
    const brokenCfg = loadConfig({ LOCALAPPDATA: join(temporary, "broken-lad"), NAVI_URL: `http://127.0.0.1:${await freePort()}`, NAVI_WIN_RUNTIME: brokenRuntime }, process.platform);
    const brokenLauncher = createLauncher(brokenCfg);
    brokenLauncher.approveFreshStart();
    const broken = await brokenLauncher.ensureRunning(10_000);
    assert.equal(broken.kind, "failed");
    assert.match(broken.message, /起来就退出了[\s\S]*fake server crashed/);
    console.log("✓ 端口被别的 Navi / 别的程序占着时不起并说清楚；连别处不替它起；起来就退时带上日志");
  }
} finally {
  for (const pid of started) { try { process.kill(pid, "SIGTERM"); } catch {} }
  for (const server of servers) server.close();
  rmSync(temporary, { recursive: true, force: true });
}
