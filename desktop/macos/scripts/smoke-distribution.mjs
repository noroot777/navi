import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../shared/runtime-smoke.mjs";
import { ARCHITECTURES, assertArchitecture, buildArchitecture } from "./architecture.mjs";
import { appInfo } from "./release-artifacts.mjs";

export function verifyNativeArchitecture(app, architecture) {
  const target = ARCHITECTURES[assertArchitecture(architecture)].swift;
  const runtime = join(app, "Contents/Resources/app");
  const native = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name === "spawn-helper")) native.push(filename);
    }
  };
  walk(join(runtime, "node_modules"));
  assert.ok(native.some((filename) => filename.endsWith("pty.node")), "安装包缺少原生 node-pty");
  for (const filename of [join(app, "Contents/MacOS/Navi"), join(runtime, "node/bin/node"), ...native]) {
    const result = spawnSync("lipo", ["-archs", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.trim().split(/\s+/).includes(target), `${filename} 不支持 ${target}`);
  }
  return runtime;
}

export async function smokeDistribution(app, architecture = process.env.NAVI_MAC_ARCH || process.arch) {
  buildArchitecture({ NAVI_MAC_ARCH: architecture });
  assert.equal(appInfo(app).NaviArchitecture, architecture);
  const runtime = verifyNativeArchitecture(app, architecture);
  const node = join(runtime, "node/bin/node");
  const probe = spawnSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    import pty from "node-pty";
    assert.equal(process.arch, ${JSON.stringify(architecture)});
    const db = new DatabaseSync(":memory:");
    assert.equal(db.prepare("select 42 as value").get().value, 42);
    db.close();
    await new Promise((resolve, reject) => {
      let output = "";
      const child = pty.spawn("/bin/sh", ["-c", "printf NAVI_PTY_OK"], { name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
      const timer = setTimeout(() => { child.kill(); reject(new Error("pty timeout")); }, 10000);
      child.onData((data) => { output += data; });
      child.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 && output.includes("NAVI_PTY_OK") ? resolve() : reject(new Error(output)); });
    });
    console.log("SQLITE_PTY_OK", process.arch);
  `], { cwd: join(runtime, "server"), encoding: "utf8", timeout: 20_000 });
  assert.equal(probe.status, 0, `${probe.error ?? ""}\n${probe.stdout}${probe.stderr}`);
  const directory = mkdtempSync(join(tmpdir(), "navi-distribution-smoke-"));
  let server;
  try {
    server = await startServer({ node, runtime, dataDir: directory });
    console.log(`DISTRIBUTION_SMOKE_OK ${architecture}: native binaries, sqlite, pty, server health`);
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeDistribution(resolve(process.argv[2] ?? "desktop/macos/build/Navi.app")).catch((error) => { console.error(error); process.exitCode = 1; });
}
