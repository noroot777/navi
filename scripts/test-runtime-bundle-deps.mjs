// 打包前核对检出里的依赖：desktop/shared/runtime-bundle.mjs 的 staleDependencies。
// 拉了新代码、package-lock.json 多了包而 node_modules 还是旧的，打包得先 npm install 再 build。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleDependencies } from "../desktop/shared/runtime-bundle.mjs";

const repo = mkdtempSync(join(tmpdir(), "navi-bundle-deps-"));
const write = (file, packages) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), JSON.stringify({ lockfileVersion: 3, packages }));
};
const lock = {
  "": { name: "navi" },
  server: { name: "@navi/server" },
  "node_modules/@navi/server": { resolved: "server", link: true },
  "node_modules/@xterm/headless": { version: "6.0.0" },
  "server/node_modules/ws": { version: "8.0.0" },
  "node_modules/@esbuild/linux-x64": { version: "0.25.0", optional: true },
};
try {
  write("package-lock.json", lock);
  assert.equal(staleDependencies(repo), null, "没装过依赖");

  const { "node_modules/@esbuild/linux-x64": _, ...installed } = lock;
  write("node_modules/.package-lock.json", installed);
  assert.deepEqual(staleDependencies(repo), [], "装齐了；别的平台的可选包没装不算");

  const { "node_modules/@xterm/headless": __, ...missing } = installed;
  write("node_modules/.package-lock.json", { ...missing, "server/node_modules/ws": { version: "7.0.0" } });
  assert.deepEqual(staleDependencies(repo), ["@xterm/headless", "ws"], "新增的包没装、嵌套的包版本旧");

  write("node_modules/.package-lock.json", { ...installed, "node_modules/@navi/server": { resolved: "elsewhere", link: true } });
  assert.deepEqual(staleDependencies(repo), ["@navi/server"], "工作区链接指错了地方");
  console.log("✓ test-runtime-bundle-deps");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
