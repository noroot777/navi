#!/usr/bin/env node
// 在 Windows 上验桌面壳（remote-smoke.mjs --shell 把便携版送到测试机上跑它；本机是 Windows 也能直接跑）：
//
//   node shell-check.mjs <便携版目录：Navi.exe + runtime\> <工作目录>
//
// 一切都落在工作目录里：假的 LOCALAPPDATA（数据根、运行时仓库、WebView2 数据都在它下面），服务用随机端口。
// 4317 只读一次 /api/health（验「被占着时说清楚、不连上去」），不起、不停、不碰它的数据。
// 窗口按 UI 自动化元素找、按元素点（进程号认窗口，名字认按钮），不按屏幕坐标。
//
// 每一项打一行 ✓ / ✕，有 ✕ 就以 1 退出。起过的 Navi.exe、服务、测试进程在 finally 里结束；登录项的测试值删掉再核一遍。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const app = resolve(process.argv[2] ?? "");
const work = resolve(process.argv[3] ?? "");
const exe = join(app, "Navi.exe");
const launcherDir = join(app, "runtime", "desktop", "windows", "launcher");
if (!existsSync(exe) || !existsSync(launcherDir)) {
  console.error(`用法：node shell-check.mjs <便携版目录> <工作目录>（${exe} 或 ${launcherDir} 不在）`);
  process.exit(2);
}
const load = (name) => import(pathToFileURL(join(launcherDir, name)).href);
const { loadConfig, samePath } = await load("config.mjs");
const { runPowerShell, psq, registryPath, readRunEntry, writeRunEntry } = await load("win-ps.mjs");
const { tryStartLock } = await load("start-lock.mjs");
const { mergePath } = await load("server-env.mjs");

let failures = 0;
const pass = (line) => console.log(`✓ ${line}`);
const fail = (line) => { failures++; console.log(`✕ ${line}`); };
const note = (line) => console.log(`  ${line}`);
const check = (ok, line, why = "") => (ok ? pass(line) : fail(why ? `${line}：${why}` : line));
const spawned = new Set();

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// /api/health 的进程号在顶层、身份在 instance 里：合成一份 { pid, id, dataDir, … }。
async function health(port) {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!answer.ok) return { status: answer.status };
    const body = await answer.json();
    return { ...body, instance: body.instance ? { pid: body.pid, ...body.instance } : null };
  } catch { return null; }
}

async function waitFor(what, timeoutMs, test, every = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${Math.round(timeoutMs / 1000)} 秒内没等到${what}`);
    await sleep(every);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const kill = (pid) => spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
// 去掉空行：文件以换行结尾时 split 末尾多一个空串，拿行数当起点 slice 会把新写的第一行跳过。
const logLines = (file) => { try { return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; } };

function launch(env, args = []) {
  const child = spawn(exe, args, { env, detached: true, stdio: "ignore" });
  child.unref();
  spawned.add(child.pid);
  return child.pid;
}

// ── UI 自动化：按进程号找 Navi 的顶层窗口，按名字找按钮 ─────────────────────────
const UIA = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
function Top($id) { @($A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, (New-Object Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$id)))) | Where-Object { -not $_.Current.Name.EndsWith('-siw') } | Select-Object -First 1 }`;
// 单实例插件也开了一个顶层窗口（名字是 <identifier>-siw），跳过它。

function windowOf(pid) {
  return runPowerShell(`${UIA}
$w = Top ${Number(pid)}
if ($w) { @{ name = $w.Current.Name; hwnd = $w.Current.NativeWindowHandle; offscreen = $w.Current.IsOffscreen } } else { $null }`);
}

function pressButton(pid, prefix) {
  return runPowerShell(`${UIA}
$w = Top ${Number(pid)}
if (-not $w) { return 'no-window' }
$buttons = $w.FindAll([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Button)))
foreach ($b in $buttons) {
  if ($b.Current.Name.StartsWith(${psq(prefix)})) { $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke(); return 'pressed' }
}
'no-button:' + (($buttons | ForEach-Object { $_.Current.Name }) -join '|')`, { timeoutMs: 30_000 });
}

function closeWindow(pid) {
  return runPowerShell(`${UIA}
$w = Top ${Number(pid)}
if (-not $w) { return 'no-window' }
$w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close(); 'closed'`);
}

// 经 WebView2 的调试端口（CDP）问页面：它在哪、有没有 Tauri 的 IPC、页面认没认约定、试着报一次的结果。
async function inspectPage(devtools, windowPort) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const target = targets.find((item) => item.type === "page" && item.url.includes(`:${windowPort}`)) ?? targets.find((item) => item.type === "page");
    if (!target) return { targets: targets.map((item) => item.url) };
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("连不上 CDP")); });
    const expression = `(async () => ({
      href: location.href, internals: typeof window.__TAURI_INTERNALS__, script: Boolean(window.__naviShellReport),
      chrome: document.querySelector("meta[name='navi-window-chrome']")?.content ?? null,
      size: document.documentElement.dataset.windowSize ?? null, text: (document.body?.innerText ?? "").slice(0, 300),
      ipc: window.__TAURI_INTERNALS__ ? await window.__TAURI_INTERNALS__.invoke("page_report", { kind: "probe" }).then(() => "ok", (error) => "err:" + String(error)) : "none",
    }))()`;
    const answer = await new Promise((resolve) => {
      socket.onmessage = (event) => resolve(JSON.parse(event.data));
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      setTimeout(() => resolve({ timeout: true }), 10_000);
    });
    socket.close();
    return answer.result?.result?.value ?? answer;
  } catch (error) {
    return { error: error.message };
  }
}

// ── Job：建一个（可选允许脱离）带 KILL_ON_JOB_CLOSE 的作业，把 PowerShell 自己收进去再让它起 Navi.exe --spawn-detached ──
const JOB_CS = `using System; using System.Runtime.InteropServices;
public static class NaviCheckJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a; public long b; public uint Flags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Ext { public Basic B; public Io I; public UIntPtr a, b, c, d; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref Ext i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Ext i, uint l, IntPtr r);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 自己所在的那个作业的 LimitFlags（不在作业里是 none）。
  public static string OwnFlags() {
    bool inJob; IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob);
    if (!inJob) return "none";
    Ext info; return QueryInformationJobObject(IntPtr.Zero, 9, out info, (uint)Marshal.SizeOf(typeof(Ext)), IntPtr.Zero) ? "0x" + info.B.Flags.ToString("X") : "unknown";
  }
  public static string InJob(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return "unknown";
    try { bool r; IsProcessInJob(h, IntPtr.Zero, out r); return r ? "yes" : "no"; } finally { CloseHandle(h); }
  }
  public static int Enter(uint flags) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    Ext info = new Ext(); info.B.Flags = flags;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Ext)))) return Marshal.GetLastWin32Error();
    return AssignProcessToJobObject(job, GetCurrentProcess()) ? 0 : Marshal.GetLastWin32Error();
  }
}`;

function spawnInJob(flags, log, program, args) {
  // 作业只在这个 PowerShell 里有句柄：它一退出作业就关了，KILL_ON_JOB_CLOSE 会结束里面剩下的一切。
  // Windows PowerShell 5.1 的 ProcessStartInfo 没有 ArgumentList：逐个加引号拼成一条（这几个参数里都没有引号）。
  const argv = ["--spawn-detached", log, program, ...args].map((arg) => `"${arg}"`).join(" ");
  return runPowerShell(`Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JOB_CS).toString("base64")}')))
${flags === null ? "$entered = 'no-job'" : `$entered = [NaviCheckJob]::Enter(${flags})`}
$psi = New-Object Diagnostics.ProcessStartInfo ${psq(exe)}, ${psq(argv)}
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
$p = [Diagnostics.Process]::Start($psi); $out = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
@{ entered = [string]$entered; code = $p.ExitCode; out = $out.Trim() }`, { timeoutMs: 90_000 });
}

const jobHelper = `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JOB_CS).toString("base64")}')))`;
const ownJobFlags = () => runPowerShell(`${jobHelper}\n[NaviCheckJob]::OwnFlags()`, { timeoutMs: 90_000 });
const inJob = (pid) => runPowerShell(`${jobHelper}\n[NaviCheckJob]::InJob(${Number(pid)})`, { timeoutMs: 90_000 });

// ────────────────────────────────────────────────────────────────────────────
const port = await freePort();
const lad = join(work, "lad");
const base = { ...process.env };
for (const key of Object.keys(base)) if (/^(NAVI_|ASH_|HARNESS_|PORT$)/i.test(key)) delete base[key];
// 给 WebView2 开远程调试端口：页面不表态时进去看它手上有没有 IPC、画到了哪一步（只在这次检查里开）。
const devtoolsPort = await freePort();
const env = { ...base, LOCALAPPDATA: lad, NAVI_URL: `http://127.0.0.1:${port}`, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${devtoolsPort}` };
const cfg = loadConfig(env, "win32");
console.log(`node ${process.version}，${spawnSync("cmd.exe", ["/d", "/c", "ver"], { encoding: "utf8" }).stdout.trim()}`);
note(`LOCALAPPDATA=${lad}`);
note(`服务 ${cfg.baseURL}，窗口端口 ${cfg.windowPort}，数据 ${cfg.dataDir}`);
const runKey = `NaviCheck-${process.pid}`;
note(`检查自己所在的作业：${ownJobFlags()}（explorer 打开的程序实测是 0x1800：允许脱离、不连带结束）`);
let serverPid = null;

try {
  // 1. 启动锁：Windows 上靠 libuv 的 UV_FS_O_EXLOCK（共享模式 0）。另一个进程拿不到，放开后能拿到。
  {
    const dir = join(work, "lock");
    const release = tryStartLock(dir);
    const probe = () => spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { tryStartLock } from ${JSON.stringify(pathToFileURL(join(launcherDir, "start-lock.mjs")).href)}; const r = tryStartLock(${JSON.stringify(dir)}); console.log(r ? "got" : "held"); r?.();`], { encoding: "utf8" }).stdout.trim();
    const whileHeld = probe();
    release?.();
    const afterRelease = probe();
    check(release && whileHeld === "held" && afterRelease === "got", "启动锁跨进程互斥", `本进程 ${Boolean(release)}，持有时另一进程 ${whileHeld}，放开后 ${afterRelease}`);
  }

  // 2. PATH 从注册表现读，claude / codex 的 .cmd 垫片找得到
  {
    const fresh = mergePath(registryPath(), process.env.Path ?? process.env.PATH ?? "", true);
    const where = spawnSync("where.exe", ["claude", "codex"], { env: { ...process.env, Path: fresh }, encoding: "utf8" });
    const found = where.stdout.trim().split(/\r?\n/).filter(Boolean);
    note(`注册表 PATH 下 where claude codex：${found.join("；") || "（都没有）"}`);
    check(found.length > 0, "注册表现读的 PATH 能找到 agent 命令");
  }

  // 3. 登录项写进 HKCU\…\Run（测试用的值名，测完删掉）
  {
    const command = `"${exe}" --start-server`;
    writeRunEntry(runKey, command);
    const written = readRunEntry(runKey);
    writeRunEntry(runKey, null);
    const removed = readRunEntry(runKey);
    check(written.command === command && removed.command === null, "HKCU Run 写入、读回、删除", JSON.stringify({ written, removed }));
  }

  // 4. --spawn-detached 在三种 Job 处境下的行为
  {
    const sleeper = [join(app, "runtime", "node", "node.exe"), ["-e", "setTimeout(() => {}, 600000)"]];
    const log = join(work, "spawn.log");
    const cases = [
      ["不另建作业（就在检查所在的作业里）", null, (r) => r.code === 0],
      ["KILL_ON_JOB_CLOSE + 允许脱离", 0x2000 | 0x800, (r) => r.code === 0 && JSON.parse(r.out).job === "escaped"],
      ["KILL_ON_JOB_CLOSE、不许脱离", 0x2000, (r) => r.code === 3 && JSON.parse(r.out).code === "job-kill-on-close"],
    ];
    for (const [name, flags, ok] of cases) {
      const result = spawnInJob(flags, log, ...sleeper);
      note(`${name}：进作业 ${result.entered}，退出码 ${result.code}，${result.out}`);
      let pid = null;
      try { pid = JSON.parse(result.out).pid ?? null; } catch {}
      if (pid) spawned.add(pid);
      // 作业所在的 PowerShell 已经退了（作业关了）：起出来的进程还活着，才算真脱离。
      if (pid) await sleep(1500);
      const survived = pid ? alive(pid) : null;
      check(ok(result) && survived !== false, `--spawn-detached：${name}`, `活着 ${survived}`);
      if (pid) note(`作业关掉 1.5 秒后进程 ${pid} ${survived ? "还在" : "没了"}，在作业里：${survived ? inJob(pid) : "-"}`);
      if (pid) kill(pid);
    }
  }

  // 5. 第一次打开：首启那一屏 → 按「全新开始」→ 服务起来、认人、页面载入
  const shellLog = join(cfg.logsDir, "shell.log");
  let shellPid = launch(env);
  const firstWindow = await waitFor("Navi 窗口", 60_000, () => windowOf(shellPid));
  note(`窗口：${JSON.stringify(firstWindow)}`);
  await waitFor("首启那一屏", 30_000, () => logLines(shellLog).some((line) => line.includes("→ screen firstRun")));
  pass("数据根还空着：首启那一屏");
  // 那一屏刚画出来的那一下，WebView 的无障碍树可能还是隐藏时的样子：Invoke 报成功、点击却没落到按钮上（实测过一次）。
  // 所以点完要看控制器真收到了；没收到隔两秒再点，点了几次如实打出来。
  let attempts = 0;
  const pressed = await waitFor("控制器收到「全新开始」", 30_000, async () => {
    attempts += 1;
    const answer = pressButton(shellPid, "全新开始");
    await sleep(1500);
    return answer === "pressed" && logLines(shellLog).some((line) => line.includes("← action fresh")) ? answer : null;
  }, 500);
  check(pressed === "pressed", `按元素点「全新开始」，控制器收到了（点了 ${attempts} 次）`);
  const started = Date.now();
  const instance = await waitFor("服务应答", 20 * 60_000, async () => (await health(port))?.instance, 2000);
  serverPid = instance.pid;
  {
    const where = inJob(serverPid);
    note(`服务进程 ${serverPid} 在作业里：${where}`);
    // 不判：脱离出去的进程照样报「在某个作业里」（上面两个用例里，作业关掉后进程还活着、却也报 yes）。
    // 要紧的是壳那一侧的作业关掉时服务不跟着走，由那两个用例和下面「壳被强杀」直接验。
  }
  spawned.add(serverPid);
  note(`服务 ${serverPid} 应答，用了 ${Math.round((Date.now() - started) / 1000)} 秒（含第一次发布运行时）`);
  note(`instance：${JSON.stringify(instance)}`);
  check(samePath(instance.dataDir, cfg.dataDir, true), "认人：数据根是这个 app 的", instance.dataDir);
  check(typeof instance.codeDir === "string" && samePath(join(instance.codeDir, ".."), cfg.runtimeStore, true), "认人：代码是发布出来的运行时", instance.codeDir);
  check(instance.desktop === true, "认人：桌面版标记", JSON.stringify(instance));
  check(instance.windowPort === cfg.windowPort, "认人：窗口专用端口", String(instance.windowPort));
  const viaWindow = await waitFor("窗口端口应答", 30_000, async () => (await health(cfg.windowPort))?.instance);
  check(viaWindow.id === instance.id, "窗口端口上是同一份服务");
  const presented = waitFor("页面表态", 60_000, () => logLines(shellLog).some((line) => /← report (size:|titlebar)/.test(line)));
  presented.catch(() => {});
  await sleep(4000);
  note(`页面里：${JSON.stringify(await inspectPage(devtoolsPort, cfg.windowPort))}`);
  await presented;
  pass("页面载进来了，并经 IPC 报回（页面那一份能力生效）");
  note(`窗口标题：${windowOf(shellPid)?.name}`);

  // 6. 关窗：窗口收进托盘，壳和服务都还在
  check(closeWindow(shellPid) === "closed", "按元素关窗");
  await sleep(2000);
  check(alive(shellPid), "关窗后壳还在（收进托盘）");
  check((await health(port))?.instance?.pid === serverPid, "关窗后服务照常应答");

  // 7. 第二次打开带 navi:// 链接：交给开着的那份、自己退出，窗口回到前面
  {
    const linkLines = logLines(shellLog).length;
    const second = launch(env, ["navi://open?task=check123"]);
    await waitFor("第二份退出", 20_000, () => !alive(second));
    pass("第二次打开：单实例，自己退出");
    await waitFor("链接转交", 10_000, () => logLines(shellLog).slice(linkLines).some((line) => line.includes("← link navi://open?task=check123")));
    pass("链接转交给了开着的那份");
    const shown = await waitFor("窗口回来", 10_000, () => windowOf(shellPid));
    note(`窗口：${JSON.stringify(shown)}`);
  }

  // 8. 壳被强杀：服务不跟着走
  kill(shellPid);
  await waitFor("壳退出", 10_000, () => !alive(shellPid));
  await sleep(3000);
  check((await health(port))?.instance?.pid === serverPid, "壳被强杀后服务照常应答（同一个进程）");

  // 9. 再打开：认出在跑的那份直接载，不另起
  {
    const before = logLines(shellLog).length;
    shellPid = launch(env);
    await waitFor("窗口", 60_000, () => windowOf(shellPid));
    await waitFor("页面载入", 60_000, () => logLines(shellLog).slice(before).some((line) => /← report (size:|titlebar)/.test(line)));
    check((await health(port))?.instance?.pid === serverPid, "再打开：接上原来那份服务，没有另起");
    kill(shellPid);
  }

  // 10. --start-server：服务在跑时直接报就绪
  {
    const run = spawnSync(exe, ["--start-server"], { env, timeout: 90_000 });
    const last = logLines(cfg.loginLog).filter(Boolean).at(-1) ?? "";
    note(`login.log：${last}`);
    check(run.status === 0 && last.includes("已就绪"), "--start-server 认出在跑的那份");
  }

  // 11. 4317 被别的 Navi 占着：说清楚是谁，不连上去、不另起
  {
    const before = await health(4317);
    note(`4317 上：${before ? JSON.stringify(before.instance ?? before).slice(0, 300) : "没人应答"}`);
    const lad2 = join(work, "lad-default");
    const env2 = { ...base, LOCALAPPDATA: lad2 };
    const cfg2 = loadConfig(env2, "win32");
    const pid = launch(env2);
    const line = await waitFor("端口被占着那一屏", 60_000, () => logLines(join(cfg2.logsDir, "shell.log")).find((text) => text.includes("→ screen offline")));
    note(line.replace(/^\S+ /, ""));
    check(/4317 端口被占着/.test(line), "默认端口被占时：说明是谁占着");
    check(!logLines(join(cfg2.logsDir, "shell.log")).some((text) => text.includes("→ load")), "没有把那份载进窗口");
    const after = await health(4317);
    check(!before || after?.instance?.pid === before.instance?.pid, "4317 上那份没被碰（进程没变）");
    check(!(await health(cfg2.windowPort)), "也没有另起服务");
    kill(pid);
  }
} catch (error) {
  fail(error.message);
  for (const file of [join(cfg.logsDir, "shell.log"), cfg.serverLog]) {
    note(`── ${file} 末尾 ──`);
    for (const line of logLines(file).filter(Boolean).slice(-40)) note(line.slice(0, 400));
  }
} finally {
  for (const pid of spawned) if (alive(pid)) kill(pid);
  try { writeRunEntry(runKey, null); } catch {}
  await sleep(1000);
  const left = [...spawned].filter(alive);
  const run = (() => { try { return readRunEntry(runKey).command; } catch (error) { return error.message; } })();
  check(!left.length && run === null, "收尾：起过的进程都结束了，登录项测试值已删", JSON.stringify({ left, run }));
  console.log(failures ? `✕ ${failures} 项没过` : "✓ 全部通过");
  process.exit(failures ? 1 : 0);
}
