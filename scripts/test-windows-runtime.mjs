// Windows 自带运行时里不依赖 Windows 就能验的那几件（在 mac 上也跑）：
//   · 内容清单 format 2：不记可执行位、不许链接、按内容寻址发布（暂存 → 改名）、已发布的不覆盖、校验不过不用；
//     mac 的 format 1 不受影响。
//   · %LOCALAPPDATA%\Navi 下的布局。
//   · 原生文件检查认得出 x64 PE / 别的架构 / Mach-O / ELF / 冒名的 .node。
//   · @navi/shared 转发包：按 exports 生成，经包名加载到的就是 shared 源码那一份。
// 真起服务、ConPTY、Windows 上的改名与删除，见 desktop/windows/scripts/smoke-runtime.mjs（要在 Windows 上跑）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime, sealRuntime, verifyRuntime } from "../desktop/shared/runtime-store.mjs";
import { claimScratch, reclaimScratch } from "../desktop/shared/scratch.mjs";
import { binaryKind, scanWindowsBinaries } from "../desktop/windows/scripts/binary-check.mjs";
import { dataRoot, logsDir, runtimeStore } from "../desktop/windows/scripts/layout.mjs";
import { writeSharedForwarder } from "../desktop/windows/scripts/win-deps.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
reclaimScratch(tmpdir(), "navi-windows-runtime-");
const temporary = realpathSync(claimScratch(tmpdir(), "navi-windows-runtime-"));
const publish = (source, store) => installRuntime(source, store, { activate: false });
// 那台 Windows 测试机建不出符号链接：链接相关的几条只在建得出来的系统上跑。
const canLink = process.platform !== "win32";

function payload(directory, version) {
  for (const folder of ["node", "server/dist/db", "scripts"]) mkdirSync(join(directory, folder), { recursive: true });
  writeFileSync(join(directory, "node/node.exe"), "MZ fake");
  writeFileSync(join(directory, "server/dist/db/schema.js"), "export const schema = 1;");
  writeFileSync(join(directory, "server/dist/index.js"), `console.log(${JSON.stringify(version)});`);
  writeFileSync(join(directory, ".in-use"), "");
  return directory;
}

try {
  // ── 清单 format 2 ────────────────────────────────────────────────────────
  const source = payload(join(temporary, "install/runtime"), "one");
  const manifest = sealRuntime(source, { platform: "win32" });
  assert.equal(manifest.format, 2);
  assert.equal(manifest.platform, "win32");
  assert.ok(manifest.entries.filter(([, kind]) => kind === "file").every((entry) => entry.length === 3), "format 2 不该记可执行位");
  assert.ok(existsSync(join(source, ".handover.json")));
  chmodSync(join(source, "node/node.exe"), 0o755);
  assert.equal(verifyRuntime(source).id, manifest.id, "可执行位变了不该影响 Windows 清单");
  console.log("✓ format 2 不记可执行位，mac 上封、Windows 上验对得上");

  const store = runtimeStore({ LOCALAPPDATA: join(temporary, "LocalAppData") });
  const published = publish(source, store);
  assert.equal(published, join(store, manifest.id));
  assert.equal(publish(source, store), published, "同一份再发布应原样复用");
  assert.deepEqual(readdirSync(store).filter((name) => name.startsWith(".installing-")), []);
  assert.equal(readFileSync(join(published, "server/dist/index.js"), "utf8"), readFileSync(join(source, "server/dist/index.js"), "utf8"));
  const next = payload(join(temporary, "install/next"), "two");
  const nextID = sealRuntime(next, { platform: "win32" }).id;
  assert.notEqual(nextID, manifest.id);
  assert.equal(publish(next, store), join(store, nextID));
  assert.ok(existsSync(published), "发布新版不该动旧版");
  console.log("✓ 发布到 <LOCALAPPDATA>\\Navi\\runtimes\\<sha256>，幂等，新旧并存，暂存目录不留");

  writeFileSync(join(published, "server/dist/index.js"), "tampered");
  assert.throws(() => publish(source, store), /校验失败/, "已发布的那份坏了要拒绝，不能悄悄当好的用");
  assert.equal(readFileSync(join(published, "server/dist/index.js"), "utf8"), "tampered", "已发布的目录不覆盖");
  const tampered = join(temporary, "tampered");
  cpSync(next, tampered, { recursive: true });
  writeFileSync(join(tampered, "server/dist/index.js"), "changed after sealing");
  assert.throws(() => publish(tampered, store), /校验失败/);
  assert.deepEqual(readdirSync(store).filter((name) => name.startsWith(".installing-")), []);
  console.log("✓ 清单对不上不用：源不对拒绝发布，已发布的坏了拒绝复用且不被覆盖");

  // 发布中途被杀留下的暂存：属主已经不在的由下一次发布收掉；属主还活着的、不带属主的老名字都不动。
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  const stale = join(store, `.installing-${gone}-${randomUUID()}`);
  const live = join(store, `.installing-${process.pid}-${randomUUID()}`);
  const legacy = join(store, `.installing-${randomUUID()}`);
  for (const stage of [stale, live, legacy]) {
    mkdirSync(join(stage, "server"), { recursive: true });
    writeFileSync(join(stage, "server/half-copied.js"), "");
  }
  assert.equal(publish(next, store), join(store, nextID));
  assert.ok(!existsSync(stale), "属主已经不在的暂存应被收掉");
  assert.ok(existsSync(live) && existsSync(legacy), "属主活着的、认不出属主的暂存不该动");
  for (const stage of [live, legacy]) rmSync(stage, { recursive: true, force: true });
  console.log("✓ 发布中途被杀留下的暂存由下一次发布收掉，别人正在用的不动");

  if (canLink) {
    const linked = payload(join(temporary, "linked"), "three");
    mkdirSync(join(linked, "node_modules/@navi"), { recursive: true });
    symlinkSync("../../server", join(linked, "node_modules/@navi/server"));
    assert.throws(() => sealRuntime(linked, { platform: "win32" }), /不能包含链接/);
    assert.equal(sealRuntime(linked).format, 1, "mac 仍是 format 1，允许包内相对链接");
    assert.ok(sealRuntime(linked).entries.some(([, kind]) => kind === "link"));
    console.log("✓ Windows 运行时一个链接都不许有；mac 的 format 1 照旧");
  }

  // ── 布局 ────────────────────────────────────────────────────────────────
  const local = join(temporary, "Local");
  assert.equal(runtimeStore({ LOCALAPPDATA: local }), join(local, "Navi", "runtimes"));
  assert.equal(dataRoot({ LOCALAPPDATA: local }), join(local, "Navi", "data"));
  assert.equal(logsDir({ LOCALAPPDATA: local }), join(local, "Navi", "data", "logs"));
  assert.throws(() => runtimeStore({}), /LOCALAPPDATA/);
  assert.throws(() => runtimeStore({ LOCALAPPDATA: "relative" }), /LOCALAPPDATA/);
  console.log("✓ 运行时、数据根、日志都在 %LOCALAPPDATA%\\Navi 下");

  // ── 原生文件检查 ──────────────────────────────────────────────────────────
  const pe = (machine) => {
    const bytes = Buffer.alloc(0x100);
    bytes.write("MZ", 0, "latin1");
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write("PE\0\0", 0x80, "latin1");
    bytes.writeUInt16LE(machine, 0x84);
    return bytes;
  };
  const binaries = join(temporary, "binaries");
  mkdirSync(join(binaries, "nested"), { recursive: true });
  writeFileSync(join(binaries, "ok.node"), pe(0x8664));
  writeFileSync(join(binaries, "nested/arm.dll"), pe(0xaa64));
  writeFileSync(join(binaries, "pty.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]));
  writeFileSync(join(binaries, "spawn-helper"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
  writeFileSync(join(binaries, "linux.so"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  writeFileSync(join(binaries, "Fake.class"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]));
  writeFileSync(join(binaries, "text.node"), "not a binary");
  writeFileSync(join(binaries, "readme.md"), "MZ but too short");
  if (canLink) symlinkSync("ok.node", join(binaries, "alias.node"));
  assert.deepEqual(binaryKind(join(binaries, "ok.node")), { kind: "pe", machine: "x64" });
  const scan = scanWindowsBinaries(binaries);
  assert.deepEqual(scan.native, ["ok.node"]);
  assert.deepEqual(scan.problems.sort(), [
    ...(canLink ? ["alias.node：是链接"] : []), "linux.so：elf", "nested/arm.dll：pe arm64", "pty.node：mach-o", "spawn-helper：mach-o", "text.node：扩展名是原生文件，内容却不是 PE",
  ]);
  console.log("✓ 只认 x64 PE：别的架构、Mach-O（含 fat）、ELF、冒名 .node、链接都会被拦下，Java class 不误报");

  // ── @navi/shared 转发包 ─────────────────────────────────────────────────
  const app = join(temporary, "app");
  mkdirSync(join(app, "server"), { recursive: true });
  cpSync(join(root, "shared/package.json"), join(app, "shared/package.json"));
  cpSync(join(root, "shared/src"), join(app, "shared/src"), { recursive: true });
  writeFileSync(join(app, "server/package.json"), JSON.stringify({ name: "@navi/server", type: "module" }));
  const exported = Object.keys(JSON.parse(readFileSync(join(root, "shared/package.json"), "utf8")).exports).length;
  assert.equal(writeSharedForwarder(join(app, "node_modules"), join(app, "shared/package.json")), exported);
  assert.equal(readFileSync(join(app, "node_modules/@navi/shared/index.js"), "utf8"), 'export * from "../../../shared/src/index.ts";\n');
  assert.equal(readFileSync(join(app, "node_modules/@navi/shared/mcp.js"), "utf8"), 'export * from "../../../shared/src/mcp.ts";\n');
  const forwarded = JSON.parse(readFileSync(join(app, "node_modules/@navi/shared/package.json"), "utf8"));
  assert.equal(forwarded.name, "@navi/shared");
  assert.equal(forwarded.exports["./mcp"], "./mcp.js");
  if (process.features.typescript) {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      for (const name of ["mcp", "code-lock", "env-names"]) {
        const viaPackage = await import("@navi/shared/" + name);
        const viaSource = await import(new URL("../shared/src/" + name + ".ts", "file://" + process.cwd() + "/").href);
        assert.deepEqual(Object.keys(viaPackage).sort(), Object.keys(viaSource).sort());
        for (const key of Object.keys(viaSource)) assert.equal(viaPackage[key], viaSource[key], name + "." + key + " 不是同一个实例");
        assert.match(import.meta.resolve("@navi/shared/" + name), /\\/node_modules\\/@navi\\/shared\\//);
      }
    `], { cwd: join(app, "server"), encoding: "utf8" });
    assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  }
  const wildcard = join(temporary, "wildcard");
  mkdirSync(wildcard);
  writeFileSync(join(wildcard, "package.json"), JSON.stringify({ name: "@navi/shared", exports: { "./*": "./src/*.ts" } }));
  const rejected = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { writeSharedForwarder } = await import(${JSON.stringify(new URL("../desktop/windows/scripts/win-deps.mjs", import.meta.url).href)});
    writeSharedForwarder(${JSON.stringify(join(wildcard, "node_modules"))}, ${JSON.stringify(join(wildcard, "package.json"))});
  `], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /转发包接不住/);
  console.log(`✓ @navi/shared 转发包覆盖全部 ${exported} 个导出，经包名加载到的就是 shared 源码那一份（${basename(app)}）`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
