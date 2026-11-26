#!/usr/bin/env node
// 在 Windows 上把安装包真装一遍、真卸一遍（云端发版 release-win.yml 的冒烟一步；本地演练见 README）：
//
//   node desktop/windows/scripts/smoke-installer.mjs <Navi-<版本>-x64-setup.exe> [--runtime <清单 id>]
//
//   1. 静默安装（/S）到默认位置：%LOCALAPPDATA%\Programs\Navi（不是 %LOCALAPPDATA%\Navi，那里是数据）
//   2. 核对：Navi.exe、自带运行时（清单 id 与构建时的一致）、卸载项、开始菜单快捷方式、navi:// 指着装上的 Navi.exe
//   3. 拿装上的那份运行时跑 smoke-runtime.mjs（发布、sqlite、ConPTY、起 server、终端；全在临时目录里）
//   4. 静默卸载：安装目录、卸载项、navi:// 都没了；%LOCALAPPDATA%\Navi 下的数据原样还在（没勾「同时删除数据」）
//
// 动的是当前用户的真实注册表和 %LOCALAPPDATA%：只在一次性的云端机器上、或者这台机器本来就没装 Navi 时跑。
// 已经装着 Navi 就拒绝（不覆盖用户的安装），%LOCALAPPDATA%\Navi 本来不在就在收尾时删掉它。中途哪一步失败，收尾都替它
// 卸掉这次装上的（卸载程序跑不了就直接删目录、登记），不然下一次一开头就因为「已经装着」被拒；收尾出的错单独报，
// 不盖掉原来那个失败。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { smokeRuntime } from "./smoke-runtime.mjs";

const step = (line) => console.log(`✓ ${line}`);
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Navi";
const PROTOCOL_KEY = "HKCU\\Software\\Classes\\navi\\shell\\open\\command";
const PROTOCOL_ROOT = "HKCU\\Software\\Classes\\navi";

/** reg query 一个值；键或值不在是 null。输出只认 ASCII 那几列（REG_SZ 后面的就是值）。 */
export function regValue(key, name = null, run = spawnSync) {
  const result = run("reg.exe", ["query", key, ...(name ? ["/v", name] : ["/ve"])], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const row = result.stdout.split(/\r?\n/).find((line) => /\sREG_(?:EXPAND_)?SZ\s/.test(line));
  return row ? row.replace(/^\s*\S.*?\s+REG_(?:EXPAND_)?SZ\s+/, "").trim() : null;
}

export async function smokeInstaller(installer, { runtime } = {}) {
  assert.equal(process.platform, "win32", "要在 Windows 上跑");
  const local = process.env.LOCALAPPDATA;
  const dir = join(local, "Programs", "Navi");
  const home = join(local, "Navi");
  assert.equal(regValue(UNINSTALL_KEY, "UninstallString"), null, "这台机器上已经装着 Navi：不覆盖用户的安装");
  assert.ok(!existsSync(dir), `${dir} 已经在了：不覆盖`);
  // 收尾失败时要删的这几样，开工前都得不在：那样收尾删到的就只会是这一次装上的
  assert.equal(regValue(PROTOCOL_ROOT, "URL Protocol"), null, "navi:// 已经登记着（别处的 Navi）：不覆盖");
  for (const shortcut of shortcuts()) assert.ok(!existsSync(shortcut), `${shortcut} 已经在了：不覆盖`);
  const homeExisted = existsSync(home);
  const marker = join(home, "data", `smoke-installer-${process.pid}.txt`);
  let installed = false;
  let uninstalled = false;
  let failed = false;
  try {
    // ── 1. 装 ──
    const install = spawnSync(resolve(installer), ["/S"], { windowsHide: true, timeout: 10 * 60_000 });
    installed = !install.error || install.error.code === "ETIMEDOUT"; // 起来了（退出码不是 0 也可能装了一半）收尾就要卸
    assert.equal(install.status, 0, `安装包退出码 ${install.status ?? install.error?.message}`);
    const exe = join(dir, "Navi.exe");
    assert.ok(existsSync(exe), `没装到 ${dir}`);
    const manifest = JSON.parse(readFileSync(join(dir, "runtime", ".runtime.json"), "utf8"));
    if (runtime) assert.equal(manifest.id, runtime, "装上的运行时不是构建出来的那一份");
    assert.ok(!existsSync(join(local, "Navi", "Navi.exe")), "装进了数据那块地（%LOCALAPPDATA%\\Navi）");
    step(`静默装到 ${dir}，运行时 ${manifest.id.slice(0, 12)}`);

    // ── 2. 登记 ──
    const uninstaller = regValue(UNINSTALL_KEY, "UninstallString");
    assert.ok(uninstaller?.toLowerCase().includes(join(dir, "uninstall.exe").toLowerCase()), `卸载项不对：${uninstaller}`);
    assert.equal(regValue(PROTOCOL_KEY)?.toLowerCase(), `"${exe}" "%1"`.toLowerCase(), "navi:// 没指向装上的 Navi.exe");
    assert.equal(regValue("HKCU\\Software\\Classes\\navi", "URL Protocol"), "", "navi 不是 URL 协议");
    const shortcut = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Navi.lnk");
    assert.ok(existsSync(shortcut), `开始菜单里没有 ${shortcut}`);
    step("卸载项、开始菜单快捷方式、navi://（HKCU\\Software\\Classes\\navi → 装上的 Navi.exe）都登记了");

    // ── 3. 装上的那份运行时 ──
    await smokeRuntime(join(dir, "runtime"));
    step("装上的运行时冒烟通过");

    // ── 4. 卸 ──
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(marker, "数据根里的东西卸载后要还在\n");
    // _?= 让卸载程序在原地跑完再返回（不然它把自己拷到临时目录、马上返回）；在原地跑时它删不掉自己，收尾补删。
    const uninstall = spawnSync(join(dir, "uninstall.exe"), ["/S", `_?=${dir}`], { windowsHide: true, timeout: 5 * 60_000 });
    assert.equal(uninstall.status, 0, `卸载退出码 ${uninstall.status ?? uninstall.error?.message}`);
    uninstalled = true;
    // 先验后收：安装目录里只许剩下卸载程序自己，验完再补删。
    const left = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((name) => name.toLowerCase() !== "uninstall.exe") : [];
    assert.deepEqual(left, [], `卸载后安装目录里还有：${left.join("、")}`);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(regValue(UNINSTALL_KEY, "UninstallString"), null, "卸载后卸载项还在");
    assert.equal(regValue(PROTOCOL_KEY), null, "卸载后 navi:// 还登记着");
    assert.ok(existsSync(marker), "卸载把数据根里的东西删了");
    step("静默卸载：程序、卸载项、navi:// 都没了，%LOCALAPPDATA%\\Navi 下的数据还在");
    console.log("WINDOWS_INSTALLER_SMOKE_OK");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const problems = [];
    const attempt = (what, run) => { try { run(); } catch (error) { problems.push(`${what}：${error.message}`); } };
    // 中途失败（包括卸了但没卸干净）：替它收掉这次装上的
    if (installed && failed) {
      problems.push(...removeInstall(dir, { uninstall: !uninstalled }));
      console.error(`中途失败：收尾时替它收掉了 ${dir}`);
    }
    attempt("删数据根里的标记", () => rmSync(marker, { force: true }));
    if (!homeExisted) attempt(`删 ${home}`, () => rmSync(home, { recursive: true, force: true }));
    if (problems.length) {
      console.error(`✕ 收尾没做干净：${problems.join("；")}`);
      if (!failed) throw new Error(`收尾没做干净：${problems.join("；")}`);
    }
  }
}

/** 安装包会建的两处快捷方式（开始菜单、静默安装时的桌面）。 */
function shortcuts() {
  return [
    join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Navi.lnk"),
    join(process.env.USERPROFILE ?? "", "Desktop", "Navi.lnk"),
  ];
}

/** 冒烟中途失败时卸掉这次装上的：先让卸载程序卸，卸不了就直接删目录、登记和快捷方式。返回没收干净的那些。 */
function removeInstall(dir, { uninstall }) {
  const problems = [];
  const uninstaller = join(dir, "uninstall.exe");
  if (uninstall && existsSync(uninstaller)) {
    const result = spawnSync(uninstaller, ["/S", `_?=${dir}`], { windowsHide: true, timeout: 5 * 60_000 });
    if (result.status !== 0) problems.push(`卸载程序退出码 ${result.status ?? result.error?.message}，改成直接删`);
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch (error) { problems.push(`删不掉 ${dir}：${error.message}`); }
  // 开工前它们都不在（见 smokeInstaller 开头），这时在的就是这一次装上的；登记还要指着这次的安装目录才删
  const ours = (value) => Boolean(value?.toLowerCase().includes(dir.toLowerCase()));
  for (const [key, value] of [[UNINSTALL_KEY, regValue(UNINSTALL_KEY, "UninstallString")], [PROTOCOL_ROOT, regValue(PROTOCOL_KEY)]]) {
    if (!ours(value)) continue;
    const removed = spawnSync("reg.exe", ["delete", key, "/f"], { encoding: "utf8", windowsHide: true });
    if (removed.status !== 0) problems.push(`删不掉注册表 ${key}`);
  }
  for (const shortcut of shortcuts()) {
    try { rmSync(shortcut, { force: true }); } catch (error) { problems.push(`删不掉 ${shortcut}：${error.message}`); }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { runtime: { type: "string" } } });
  if (positionals.length !== 1) {
    console.error("用法：node desktop/windows/scripts/smoke-installer.mjs <安装包> [--runtime <清单 id>]");
    process.exit(2);
  }
  smokeInstaller(positionals[0], values).catch((error) => { console.error(`✕ ${error.stack ?? error}`); process.exitCode = 1; });
}
