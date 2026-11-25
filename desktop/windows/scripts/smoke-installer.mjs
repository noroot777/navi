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
// 已经装着 Navi 就拒绝（不覆盖用户的安装），%LOCALAPPDATA%\Navi 本来不在就在收尾时删掉它。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { smokeRuntime } from "./smoke-runtime.mjs";

const step = (line) => console.log(`✓ ${line}`);
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Navi";
const PROTOCOL_KEY = "HKCU\\Software\\Classes\\navi\\shell\\open\\command";

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
  const homeExisted = existsSync(home);
  const marker = join(home, "data", `smoke-installer-${process.pid}.txt`);
  try {
    // ── 1. 装 ──
    const install = spawnSync(resolve(installer), ["/S"], { windowsHide: true, timeout: 10 * 60_000 });
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
    rmSync(join(dir, "uninstall.exe"), { force: true });
    rmSync(dir, { recursive: true, force: true });
    assert.ok(!existsSync(exe), "卸载后 Navi.exe 还在");
    assert.equal(regValue(UNINSTALL_KEY, "UninstallString"), null, "卸载后卸载项还在");
    assert.equal(regValue(PROTOCOL_KEY), null, "卸载后 navi:// 还登记着");
    assert.ok(existsSync(marker), "卸载把数据根里的东西删了");
    step("静默卸载：程序、卸载项、navi:// 都没了，%LOCALAPPDATA%\\Navi 下的数据还在");
    console.log("WINDOWS_INSTALLER_SMOKE_OK");
  } finally {
    rmSync(marker, { force: true });
    if (!homeExisted) rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { runtime: { type: "string" } } });
  if (positionals.length !== 1) {
    console.error("用法：node desktop/windows/scripts/smoke-installer.mjs <安装包> [--runtime <清单 id>]");
    process.exit(2);
  }
  smokeInstaller(positionals[0], values).catch((error) => { console.error(`✕ ${error.stack ?? error}`); process.exitCode = 1; });
}
