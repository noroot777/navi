// 打包前核对检出里的依赖：desktop/shared/runtime-bundle.mjs 的 staleDependencies。
// 拉了新代码、package-lock.json 多了包而 node_modules 还是旧的，打包得先 npm install 再 build；
// 认的是磁盘上的包，npm 自己的已装缓存（node_modules/.package-lock.json）说装好了也不信。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleDependencies } from "../desktop/shared/runtime-bundle.mjs";

const repo = mkdtempSync(join(tmpdir(), "navi-bundle-deps-"));
const json = (file, value) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), JSON.stringify(value));
};
const install = (path, version) => json(`${path}/package.json`, { name: path.split("node_modules/").pop(), version });
const lock = {
  "": { name: "navi" },
  server: { name: "@navi/server" },
  web: { name: "@navi/web" },
  "node_modules/@navi/server": { resolved: "server", link: true },
  "node_modules/@xterm/headless": { version: "6.0.0" },
  "server/node_modules/ws": { version: "8.0.0" },
  "web/node_modules/@types/node": { version: "22.20.1" },
  "node_modules/@esbuild/linux-x64": { version: "0.25.0", optional: true },
};
try {
  json("package-lock.json", { lockfileVersion: 3, packages: lock });
  json("server/package.json", { name: "@navi/server" });
  json("web/package.json", { name: "@navi/web" });
  assert.deepEqual(staleDependencies(repo), ["@navi/server", "@xterm/headless", "ws", "@types/node"], "一个都没装");

  mkdirSync(join(repo, "node_modules/@navi"), { recursive: true });
  symlinkSync("../../server", join(repo, "node_modules/@navi/server"));
  install("node_modules/@xterm/headless", "6.0.0");
  install("server/node_modules/ws", "8.0.0");
  install("web/node_modules/@types/node", "22.20.1");
  assert.deepEqual(staleDependencies(repo), [], "装齐了；别的平台的可选包没装不算");

  // npm 的已装缓存还记着 @types/node，磁盘上它已经被删了。
  json("node_modules/.package-lock.json", { lockfileVersion: 3, packages: lock });
  rmSync(join(repo, "web/node_modules/@types"), { recursive: true });
  install("server/node_modules/ws", "7.0.0");
  assert.deepEqual(staleDependencies(repo), ["ws", "@types/node"], "缓存说装了但磁盘上没有、嵌套的包版本旧");

  install("web/node_modules/@types/node", "22.20.1");
  install("server/node_modules/ws", "8.0.0");
  rmSync(join(repo, "node_modules/@navi/server"));
  symlinkSync("../../web", join(repo, "node_modules/@navi/server"));
  assert.deepEqual(staleDependencies(repo), ["@navi/server"], "工作区链接指错了地方");
  console.log("✓ test-runtime-bundle-deps");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
