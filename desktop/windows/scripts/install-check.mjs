#!/usr/bin/env node
// 在 Windows 上把安装、更新、交接、navi://、卸载整条走一遍（remote-install-drill.mjs 把两版演练安装包送到测试机上跑它）：
//
//   node install-check.mjs <载荷目录> <工作目录>
//
// 载荷目录里是 remote-install-drill.mjs 在开发机上做的：drill.json（这次演练的根、端口、版本），两个演练安装包
// （壳里编进了临时的 LOCALAPPDATA / USERPROFILE / NAVI_URL、临时更新公钥、指向本机 :feedPort 的更新源），
// feed\（latest.json + 新版安装包，按临时私钥签过）。一切落在演练根下：装到 <根>\l\Programs\Navi（/D=），数据、
// 运行时仓库、WebView2 数据在 <根>\l\Navi，服务的 USERPROFILE / APPDATA 在 <根>\h。动到演练根之外的只有当前
// 用户注册表里安装包本来就要写的那几项（卸载项、navi://、登录项、厂商键）和开始菜单快捷方式 —— 开头先确认它们
// 本来都不在（在就不跑），收尾时只删指向演练根的那几项；还有更新时壳在 %TEMP% 下载安装包的 Navi-<版本>-updater-*
// 目录，收尾删掉开工时没有、里面只有安装包的那几个。这条命令被中途结束（走不到收尾）时，remote-scratch.mjs 的
// 清理命令照同样的规矩删登记。:4317 上那份只读一次 /api/health，不碰。
//
// 窗口、对话框按 UI 自动化元素找、按元素点（进程号认窗口，名字认按钮），不按屏幕坐标。每一项打一行 ✓ / ✕。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const payload = resolve(process.argv[2] ?? "");
const drill = JSON.parse(readFileSync(join(payload, "drill.json"), "utf8"));
const { root, port, feedPort, from, to } = drill;
const lad = join(root, "l");
const home = join(root, "h");
const installDir = join(lad, "Programs", "Navi");
const exe = join(installDir, "Navi.exe");

let failures = 0;
const pass = (line) => console.log(`✓ ${line}`);
const fail = (line) => { failures++; console.log(`✕ ${line}`); };
const note = (line) => console.log(`  ${line}`);
const check = (ok, line, why = "") => (ok ? pass(line) : fail(why ? `${line}：${why}` : line));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const kill = (pid, tree = false) => spawnSync("taskkill.exe", ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], { windowsHide: true });
const logLines = (file) => { try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; } };
const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

function ps(script, timeoutMs = 60_000) {
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`], { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  if (run.status !== 0) throw new Error(`PowerShell 失败：${run.stderr || run.stdout}`);
  return run.stdout.trim();
}

async function waitFor(what, timeoutMs, test, every = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${Math.round(timeoutMs / 1000)} 秒内没等到${what}`);
    await sleep(every);
  }
}

async function health(at) {
  try {
    const answer = await fetch(`http://127.0.0.1:${at}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return null;
    const body = await answer.json();
    return body.instance ? { pid: body.pid, ...body.instance } : null;
  } catch { return null; }
}

/** health 报的代码根（runtimes\\<sha256>\\，可能带结尾的分隔符）→ 运行时 id。 */
const runtimeOf = (answer) => String(answer?.codeDir ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);

async function api(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: { "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ── 注册表（只认 ASCII 那几列） ─────────────────────────────────────────────
const KEYS = {
  uninstall: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Navi",
  protocol: "HKCU\\Software\\Classes\\navi",
  vendor: "HKCU\\Software\\Navi",
  run: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
};
function reg(key, name = null) {
  const result = spawnSync("reg.exe", ["query", key, ...(name === null ? ["/ve"] : ["/v", name])], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const row = result.stdout.split(/\r?\n/).find((line) => /\sREG_(?:EXPAND_)?SZ\s/.test(line));
  return row ? row.replace(/^\s*\S.*?\s+REG_(?:EXPAND_)?SZ\s+/, "").trim() : "";
}
const keyExists = (key) => spawnSync("reg.exe", ["query", key], { windowsHide: true }).status === 0;
const intoRoot = (value) => typeof value === "string" && value.toLowerCase().includes(root.toLowerCase());

// ── UI 自动化：按元素点按钮 ─────────────────────────────────────────────────
// 首启那一屏（本地页，很小）在主窗口的 UIA 树里按名字找按钮、Invoke。
// 原生对话框（TaskDialog）是单独的顶层窗口、类名 #32770，用 EnumWindows 按进程号找到它。它的按钮在 UIA 里只是
// CCPushButton 面板、不支持 Invoke（真机实测）；底下是 CtrlNotifySink 里真的 Win32 按钮窗口，按文字找到那个句柄发
// BM_CLICK —— 点的是那个按钮本身，不经屏幕坐标。也别从主窗口往下遍历去找它：页面载进来后 WebView2 的无障碍树太大。
const WIN32 = `Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class NaviTops {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Class(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  static string Text(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static IntPtr[] Of(uint pid, bool dialogs) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && (Class(h) == "#32770") == dialogs) list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  // 对话框里文字是 text 的按钮：点了返回 "pressed"，没有就列出看到的按钮。
  public static string Click(IntPtr dialog, string text) {
    IntPtr hit = IntPtr.Zero; var seen = new List<string>();
    EnumChildWindows(dialog, (h, l) => {
      if (Class(h) != "Button") return true;
      seen.Add(Text(h));
      if (Text(h) == text && IsWindowVisible(h) && IsWindowEnabled(h)) { hit = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (hit == IntPtr.Zero) return "[" + Text(dialog) + "] " + string.Join("|", seen);
    SendMessage(hit, 0x00F5, IntPtr.Zero, IntPtr.Zero);
    return "pressed";
  }
}
'@`;
function pressButton(pid, name, { dialog = false } = {}) {
  if (dialog) {
    return ps(`${WIN32}
$seen = @()
foreach ($h in [NaviTops]::Of(${Number(pid)}, $true)) { $r = [NaviTops]::Click($h, ${psq(name)}); if ($r -eq 'pressed') { return $r }; $seen += $r }
'no-button:' + ($seen -join ' ')`);
  }
  return ps(`Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
${WIN32}
$A = [Windows.Automation.AutomationElement]
$seen = @()
foreach ($h in [NaviTops]::Of(${Number(pid)}, $false)) {
  $w = $A::FromHandle($h)
  foreach ($b in $w.FindAll([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Button)))) {
    $seen += $b.Current.Name
    if ($b.Current.Name.StartsWith(${psq(name)}) -and $b.Current.IsEnabled) { $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'pressed' }
  }
}
'no-button:' + ($seen -join '|')`);
}

/** 装在演练目录里的 Navi.exe 进程（更新后是安装包重新打开的那个，进程号换了）。 */
const shells = () => ps(`Get-CimInstance Win32_Process -Filter "Name='Navi.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq ${psq(exe)} -and $_.CommandLine -notmatch '--spawn-detached|--start-server' } | ForEach-Object { $_.ProcessId }`)
  .split(/\r?\n/).filter(Boolean).map(Number);
const chromes = () => ps(`@(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`).split(",").filter(Boolean).map(Number);

/** 终端事件流：一直读着，记下最新的 NAVI_TICK 和流有没有断过。 */
function followTerminal(url) {
  const state = { tick: -1, ended: null, screen: "", controller: new AbortController() };
  (async () => {
    try {
      const response = await fetch(url, { signal: state.controller.signal, headers: { accept: "text/event-stream" } });
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { state.ended ??= "事件流结束了"; return; }
        pending += value;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === "exit") state.ended ??= `shell 退出了（${event.exitCode}）`;
          if (event.type === "data") {
            state.screen = (state.screen + event.data).slice(-4000);
            for (const match of state.screen.matchAll(/NAVI_TICK (\d+)/g)) state.tick = Math.max(state.tick, Number(match[1]));
          }
        }
      }
    } catch (error) {
      if (!state.controller.signal.aborted) state.ended ??= error.message;
    }
  })();
  return state;
}

// ── 更新源 + 「浏览器那一头」：本机 :feedPort 上的一个小服务，记下每个请求 ─────────
const hits = [];
const feedDir = join(payload, "feed");
const feed = createServer((request, response) => {
  hits.push(request.url);
  const name = decodeURIComponent(new URL(request.url, "http://x").pathname.slice(1));
  const file = join(feedDir, name);
  if (name && !name.includes("..") && existsSync(file) && statSync(file).isFile()) {
    response.writeHead(200, { "content-length": statSync(file).size });
    response.end(readFileSync(file));
  } else {
    response.writeHead(name === "fallback" ? 200 : 404, { "content-type": "text/plain" });
    response.end(name === "fallback" ? "navi drill: browser fallback reached\n" : "");
  }
});

const updaterDirs = () => { try { return readdirSync(process.env.TEMP).filter((name) => /^Navi-.+-updater-/.test(name)); } catch { return []; } };
const before = { chrome: chromes(), keys: {}, updaters: updaterDirs() };
const startMenu = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Navi.lnk");
const desktopLink = join(ps("[Environment]::GetFolderPath('Desktop')"), "Navi.lnk");
let terminal = null;
let servicePid = null;
let legacy = null;

try {
  console.log(`node ${process.version}；演练根 ${root}；服务端口 ${port}；更新源 :${feedPort}；${from} → ${to}`);
  // ── 0. 开工前：安装包会写的那几项本来都不在、端口空着 ─────────────────────────
  for (const [name, key] of Object.entries(KEYS)) before.keys[name] = name === "run" ? reg(key, "Navi") : keyExists(key) ? "present" : null;
  before.startMenu = existsSync(startMenu);
  before.desktop = existsSync(desktopLink);
  if (Object.values(before.keys).some(Boolean) || before.startMenu || before.desktop) {
    throw new Error(`这台机器上已经有 Navi 的登记（${JSON.stringify(before)}）：不在用户的安装上演练`);
  }
  if (await health(port)) throw new Error(`:${port} 已经有服务在听`);
  legacy = await health(4317);
  note(`:4317 上（只读）：${legacy ? `进程 ${legacy.pid}` : "没人应答"}`);
  feed.listen(feedPort, "127.0.0.1");
  await new Promise((done, reject) => { feed.once("listening", done); feed.once("error", reject); });
  pass("开工前：卸载项、navi://、厂商键、登录项、快捷方式都不在；端口空着");

  // ── 1. 装旧版 ──────────────────────────────────────────────────────────
  const setup = (version) => join(payload, `Navi-${version}-x64-setup.exe`);
  const installed = spawnSync(setup(from), ["/S", `/D=${installDir}`], { windowsHide: true, timeout: 10 * 60_000 });
  check(installed.status === 0 && existsSync(exe), `静默装 ${from} 到 ${installDir}`, `退出码 ${installed.status}`);
  const protocol = reg(`${KEYS.protocol}\\shell\\open\\command`);
  check(protocol?.toLowerCase() === `"${exe}" "%1"`.toLowerCase(), "navi:// 登记在 HKCU\\Software\\Classes\\navi，指着装上的 Navi.exe", protocol);
  check(reg(KEYS.protocol, "URL Protocol") === "", "navi 是 URL 协议");
  check(intoRoot(reg(KEYS.uninstall, "UninstallString")), "卸载项指着装上的 uninstall.exe");
  check(existsSync(startMenu), "开始菜单里有 Navi");
  await sleep(3000);
  check(!shells().length, "静默安装完不自己把 Navi 打开");

  // ── 2. 打开、首启、服务起来 ───────────────────────────────────────────────
  const launcher = join(installDir, "runtime", "desktop", "windows", "launcher");
  const { loadConfig } = await import(pathToFileURL(join(launcher, "config.mjs")).href);
  const cfg = loadConfig({ LOCALAPPDATA: lad, NAVI_URL: `http://127.0.0.1:${port}` }, "win32");
  const shellLog = join(cfg.logsDir, "shell.log");
  // 登录项先设成「用户选过、不开」，演练里不写 Run 项：%TEMP% 里一个没签名的 exe 一打开就把自己写进 Run，测试机上
  // Defender 判成过 Behavior:Win32/Persistence.A!ml，删掉 exe 和快捷方式、结束进程（README「本地演练」）。
  mkdirSync(dirname(cfg.settingsFile), { recursive: true });
  writeFileSync(cfg.settingsFile, JSON.stringify({ loginConfigured: true, loginWanted: false }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NAVI_|ASH_|HARNESS_|PORT$)/i.test(key)));
  spawn(exe, [], { env, detached: true, stdio: "ignore" }).unref();
  const firstShell = (await waitFor("Navi 窗口", 60_000, () => shells()[0]));
  await waitFor("首启那一屏", 60_000, () => logLines(shellLog).some((line) => line.includes("→ screen firstRun")));
  await waitFor("控制器收到「全新开始」", 40_000, async () => {
    pressButton(firstShell, "全新开始");
    await sleep(1500);
    return logLines(shellLog).some((line) => line.includes("← action fresh"));
  }, 500);
  pass("首启：按元素点「全新开始」");
  const started = Date.now();
  const first = await waitFor("服务应答", 15 * 60_000, () => health(port), 3000);
  servicePid = first.pid;
  const oldRuntime = runtimeOf(first);
  check(/^[0-9a-f]{64}$/.test(oldRuntime), "health 报的代码根是一份发布出来的运行时", first.codeDir);
  note(`服务进程 ${first.pid}，运行时 ${oldRuntime.slice(0, 12)}，用了 ${Math.round((Date.now() - started) / 1000)} 秒（含第一次发布运行时）`);
  check(first.codeDir.toLowerCase().startsWith(cfg.runtimeStore.toLowerCase()), "服务跑在发布出来的运行时里（不在安装目录里）", first.codeDir);
  check(!reg(KEYS.run, "Navi"), "登录项按设置没登记", reg(KEYS.run, "Navi"));

  // ── 3. 开一个一直在跑的终端命令 ───────────────────────────────────────────
  mkdirSync(join(home, "project"), { recursive: true });
  const project = await api("/projects", { method: "POST", body: JSON.stringify({ name: "drill", repoPath: join(home, "project") }) });
  check(project.status < 300, "建项目", JSON.stringify(project.body));
  const projectId = project.body.id;
  const opened = await api(`/projects/${projectId}/terminal/sessions`, { method: "POST", body: JSON.stringify({ cols: 120, rows: 30 }) });
  const sessionPath = `/projects/${projectId}/terminal/sessions/${opened.body.id}`;
  terminal = followTerminal(`http://127.0.0.1:${port}/api${sessionPath}/events?after=0`);
  await sleep(4000);
  await api(`${sessionPath}/input`, { method: "POST", body: JSON.stringify({ data: "for ($i = 0; ; $i++) { 'NAVI_' + 'TICK ' + $i; Start-Sleep 1 }\r" }) });
  await waitFor("终端里的计数", 30_000, () => terminal.tick >= 3);
  pass(`终端里一直在跑的命令起来了（NAVI_TICK ${terminal.tick}）`);

  // ── 4. 自动检查查到新版 → 按元素点「现在更新」 ───────────────────────────────
  await waitFor("更新对话框", 5 * 60_000, () => logLines(shellLog).some((line) => line.includes(`→ dialog`) && line.includes(`Navi ${to} 可以更新了`)), 2000);
  pass(`起来 1 分钟后自动检查，查到 ${to}，问用户`);
  check(hits.includes("/latest.json"), "从更新源读了 latest.json");
  const tickBefore = terminal.tick;
  let pressed = "";
  await waitFor("控制器收到「现在更新」", 30_000, async () => {
    pressed = pressButton(firstShell, "现在更新", { dialog: true });
    await sleep(1500);
    return logLines(shellLog).some((line) => line.includes("← dialogResult") || line.includes("→ updateInstall"));
  }, 500).catch((error) => { throw new Error(`${error.message}（最后一次找按钮：${pressed}）`); });
  pass("按元素点「现在更新」");
  await waitFor("旧壳退出", 3 * 60_000, () => !alive(firstShell), 1000);
  check(hits.includes(`/Navi-${to}-x64-setup.exe`), "下了新版安装包（签名由壳验过才会装）");
  const secondShell = await waitFor("安装包重新打开的新壳", 5 * 60_000, () => shells()[0], 2000);
  const manifest = JSON.parse(readFileSync(join(installDir, "runtime", ".runtime.json"), "utf8"));
  check(manifest.id !== oldRuntime, `安装目录里换成了 ${to} 的运行时 ${manifest.id.slice(0, 12)}`);
  check(protocol === reg(`${KEYS.protocol}\\shell\\open\\command`), "更新后 navi:// 还指着同一个 Navi.exe");
  check(!reg(KEYS.run, "Navi"), "更新没替用户把登录项打开");

  // ── 5. 新壳起来了，终端还开着：留在旧服务上等 ─────────────────────────────────
  const waiting = await waitFor("新壳说要等终端", 30 * 60_000, () => logLines(shellLog).find((line) => line.includes("等这些结束再切换") || line.includes("还不能切换")), 3000);
  note(waiting.replace(/^\S+ /, ""));
  const during = await health(port);
  check(during?.pid === servicePid && runtimeOf(during) === oldRuntime, "终端开着：服务还是原来那个进程、原来的运行时", JSON.stringify(during));
  await sleep(5000);
  check(!terminal.ended && terminal.tick > tickBefore + 5, `终端命令没被打断，一直在数（${tickBefore} → ${terminal.tick}）`, terminal.ended ?? "");
  check(/等这些结束再切换：.*终端「/.test(waiting), "等的就是那个终端", waiting);

  // ── 6. 关掉终端 → 自动切到新运行时 ───────────────────────────────────────────
  const closed = await api(sessionPath, { method: "DELETE" });
  check(closed.status === 204, "关掉终端会话");
  terminal.controller.abort();
  const switched = await waitFor("服务换到新运行时", 10 * 60_000, async () => {
    const now = await health(port);
    return now && runtimeOf(now) === manifest.id ? now : null;
  }, 3000);
  servicePid = switched.pid;
  check(switched.pid !== first.pid, `终端关了就换：新服务进程 ${switched.pid}，运行时 ${manifest.id.slice(0, 12)}`);
  const backups = existsSync(join(cfg.dataDir, "backups")) ? readdirSync(join(cfg.dataDir, "backups")).filter((name) => name.endsWith(".db")) : [];
  check(backups.length === 1, "切换前给库留了底", backups.join(", "));
  const listed = await api("/projects");
  check(listed.body?.some?.((item) => item.id === projectId), "新服务读得到原来的数据");
  for (const line of logLines(shellLog).filter((text) => /旧运行时|切换|留底|换新版/.test(text)).slice(-6)) note(line.replace(/^\S+ /, ""));

  // ── 7. navi:// ─────────────────────────────────────────────────────────────
  const tag = switched.tag;
  const route = `/?project=${projectId}&task=drill1`;
  // 走 ShellExecute（同用户在浏览器、聊天软件里点链接）。`explorer.exe <链接>` 不行：真机上它根本不调协议处理程序。
  const open = (link) => ps(`Start-Process ${psq(link)}`);
  {
    const mark = logLines(shellLog).length;
    open(`navi://open?project=${projectId}&task=drill1&instance=${tag}`);
    await waitFor("窗口里换路由", 30_000, () => logLines(shellLog).slice(mark).some((line) => line.includes(`→ route ${route}`)));
    pass("窗口开着：从系统点指纹对上的 navi:// 链接，交给开着的那个窗口、原地换到那一页");
  }
  {
    const mark = logLines(shellLog).length;
    const fallback = `http://127.0.0.1:${feedPort}/fallback?project=${projectId}&task=drill1`;
    open(`navi://open?project=${projectId}&task=drill1&instance=FFFF-0000&fallback=${encodeURIComponent(fallback)}`);
    await waitFor("交给浏览器", 30_000, () => logLines(shellLog).slice(mark).some((line) => line.includes(`→ openExternal ${fallback}`)));
    await waitFor("浏览器打开了原来的 http 地址", 60_000, () => hits.some((url) => url.startsWith("/fallback?")));
    pass("指纹对不上：交给默认浏览器，浏览器真的打开了原来那条 http 地址");
  }
  {
    for (const pid of shells()) kill(pid);
    await waitFor("壳退出", 20_000, () => !shells().length);
    const mark = logLines(shellLog).length;
    open(`navi://open?project=${projectId}&task=drill2&instance=${tag}`);
    // 首页可能先载上（启动流程比链接先到那一步），页面表态后再原地换过去：认页面自己报回的地址，或者直接整页载到那里。
    const page = `http://127.0.0.1:${cfg.windowPort}/?project=${projectId}&task=drill2`;
    await waitFor("系统拉起 Navi 并载到那一页", 90_000, () => logLines(shellLog).slice(mark).some((line) => line.includes(`← report url:${page}`) || line.includes(`→ load ${page}`)), 2000);
    pass("窗口没开：系统按 navi:// 拉起装上的 Navi，载到链接那一页");
    check((await health(port))?.pid === servicePid, "拉起窗口接的是在跑的那份服务，没另起");
  }

  // ── 8. 卸载：服务不停、数据还在 ─────────────────────────────────────────────
  const uninstall = spawnSync(join(installDir, "uninstall.exe"), ["/S", `_?=${installDir}`], { windowsHide: true, timeout: 5 * 60_000 });
  check(uninstall.status === 0, "静默卸载", `退出码 ${uninstall.status}`);
  await sleep(2000);
  check(!existsSync(exe) && !shells().length, "卸载后 Navi.exe 没了、壳也关了");
  check(!keyExists(KEYS.protocol), "卸载后 navi:// 没了");
  check(!keyExists(KEYS.uninstall), "卸载后卸载项没了");
  check(!reg(KEYS.run, "Navi"), "卸载后登录项没了");
  check(!existsSync(startMenu), "卸载后开始菜单里的 Navi 没了");
  if (!before.desktop) check(!existsSync(desktopLink), "卸载后桌面快捷方式没了（静默安装、更新会建一个）");
  check((await health(port))?.pid === servicePid, "卸载不停服务（还是同一个进程）");
  check(existsSync(join(cfg.dataDir, "navi.db")) && existsSync(join(cfg.runtimeStore, manifest.id)), "数据根和运行时仓库都还在");
  check((await api("/projects")).body?.some?.((item) => item.id === projectId), "数据原样读得到");
} catch (error) {
  fail(error.message);
  // 现场：演练目录里还活着的进程、运行时仓库里有什么、注册表那几项还在不在（收尾之前看）。
  note("── 失败时的现场 ──");
  try {
    for (const line of ps(`Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psq(root)}, 'OrdinalIgnoreCase')) -or ($_.CommandLine -and $_.CommandLine.IndexOf(${psq(root)}, [StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { '' + $_.ProcessId + ' <' + $_.ParentProcessId + ' ' + $_.Name + ' ' + (($_.CommandLine + '') -replace '\\s+', ' ') }`).split(/\r?\n/)) note(`进程 ${line.slice(0, 300)}`);
    const store = join(lad, "Navi", "runtimes");
    for (const name of existsSync(store) ? readdirSync(store) : []) note(`运行时仓库 ${name}${statSync(join(store, name)).isDirectory() ? `（${readdirSync(join(store, name)).length} 项）` : ""}`);
    note(`注册表：${Object.entries(KEYS).map(([name, key]) => `${name}=${name === "run" ? reg(key, "Navi") ?? "无" : keyExists(key)}`).join(" ")}`);
  } catch (snapshotError) { note(`现场没取全：${snapshotError.message}`); }
  const cfgLogs = join(lad, "Navi", "data", "logs");
  for (const file of ["shell.log", "server.log"].map((name) => join(cfgLogs, name))) {
    note(`── ${file} 末尾 ──`);
    for (const line of logLines(file).slice(-40)) note(line.slice(0, 400));
  }
} finally {
  // ── 收尾：停演练里起的一切，删只指向演练根的注册表项和快捷方式 ─────────────────
  terminal?.controller.abort();
  feed.close();
  for (const pid of shells()) kill(pid);
  if (servicePid && alive(servicePid)) kill(servicePid, true);
  const strays = ps(`Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith(${psq(root)}, 'OrdinalIgnoreCase')) -or ($_.CommandLine -and $_.CommandLine.IndexOf(${psq(root)}, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.ProcessId -ne ${process.pid} -and $_.CommandLine -notmatch 'install-check|run\\.ps1|check\\.vbs') } | ForEach-Object { $_.ProcessId }`)
    .split(/\r?\n/).filter(Boolean).map(Number);
  for (const pid of strays) kill(pid, true);
  const removed = [];
  if (intoRoot(reg(`${KEYS.protocol}\\shell\\open\\command`))) { spawnSync("reg.exe", ["delete", KEYS.protocol, "/f"]); removed.push("navi://"); }
  if (intoRoot(reg(KEYS.uninstall, "UninstallString"))) { spawnSync("reg.exe", ["delete", KEYS.uninstall, "/f"]); removed.push("卸载项"); }
  if (intoRoot(reg(KEYS.run, "Navi"))) { spawnSync("reg.exe", ["delete", KEYS.run, "/v", "Navi", "/f"]); removed.push("登录项"); }
  if (!before.keys.vendor && keyExists(KEYS.vendor) && (!reg(`${KEYS.vendor}\\Navi`) || intoRoot(reg(`${KEYS.vendor}\\Navi`)))) { spawnSync("reg.exe", ["delete", KEYS.vendor, "/f"]); removed.push("厂商键"); }
  for (const [file, existed] of [[startMenu, before.startMenu], [desktopLink, before.desktop]]) {
    if (!existed && existsSync(file)) { spawnSync("cmd.exe", ["/d", "/c", "del", "/f", "/q", file]); removed.push(file); }
  }
  // 浏览器是演练里经 navi:// 回退打开的：命令行里带着回退地址的那一棵（另起了一份浏览器时）结束掉；本来没开着就整个
  // 关掉，本来开着的不碰（回退地址在它里面多了一个标签页）。
  const launched = ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psq(`127.0.0.1:${feedPort}/fallback`)}) } | ForEach-Object { $_.ProcessId }`)
    .split(/\r?\n/).filter(Boolean).map(Number);
  for (const pid of launched) spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  if (launched.length) removed.push(`演练另起的浏览器 ${launched.join(",")}`);
  const opened = chromes().filter((pid) => !before.chrome.includes(pid));
  if (!before.chrome.length && opened.length) { spawnSync("taskkill.exe", ["/IM", "chrome.exe", "/T", "/F"], { windowsHide: true }); removed.push(`浏览器（演练打开的 ${opened.length} 个进程）`); }
  for (const name of updaterDirs().filter((dir) => !before.updaters.includes(dir))) {
    const dir = join(process.env.TEMP, name);
    try {
      if (!readdirSync(dir, { recursive: true }).every((file) => /^Navi-.+-installer\.exe$/.test(String(file)))) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (error) { note(`删不掉 ${dir}：${error.message}`); }
  }
  await sleep(1500);
  note(`收尾删掉：${removed.join("、") || "（没有要删的）"}${strays.length ? `；结束残留进程 ${strays.join(",")}` : ""}`);
  const left = Object.entries(KEYS).filter(([name, key]) => (name === "run" ? intoRoot(reg(key, "Navi")) : keyExists(key) && !before.keys[name]));
  check(!left.length && !existsSync(startMenu) && !existsSync(desktopLink), "收尾：注册表里演练写的都删了、快捷方式不在", JSON.stringify(left));
  const updatersLeft = updaterDirs().filter((dir) => !before.updaters.includes(dir));
  check(!updatersLeft.length, "收尾：更新时下载安装包的临时目录删了", updatersLeft.join("、"));
  check((await health(4317))?.pid === legacy?.pid, ":4317 上那份没被碰（进程没变）");
  console.log(failures ? `✕ ${failures} 项没过` : "✓ 全部通过");
  process.exit(failures ? 1 : 0);
}
