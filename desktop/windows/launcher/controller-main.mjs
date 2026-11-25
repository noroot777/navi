#!/usr/bin/env node
// 壳拉起的那个控制器进程（shell/src/controller.rs）。两种跑法：
//
//   node controller-main.mjs            窗口模式：stdin 一行一条壳发来的 JSON，stdout 一行一条发给壳的（controller.mjs 顶部）。
//                                       stdin 一断（壳退出、被强杀）就退出：控制器不守护，服务也不归它管。
//   node controller-main.mjs --ensure   `Navi.exe --start-server`（登录时那一档）：确保服务在跑就退出，不开窗口。
//                                       数据根还空着时不起：首启要问用户「全新开始」，抢先建一份空库就没得选了。
//
// 自己的诊断写进 <数据根>/logs/shell.log（--ensure 写 login.log），stdout 只留给协议。
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "./config.mjs";
import { createController } from "./controller.mjs";
import { createLauncher } from "./launcher.mjs";
import { createLoginItem } from "./login-item.mjs";

const cfg = loadConfig();
const ensure = process.argv.includes("--ensure");
const logFile = ensure ? cfg.loginLog : `${cfg.logsDir}/shell.log`;

function log(line) {
  try {
    mkdirSync(cfg.logsDir, { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch { /* 写不了日志不拦着 */ }
}

const launcher = createLauncher(cfg, { log });

if (ensure) {
  const outcome = await launcher.ensureRunning(60_000);
  const lines = {
    ready: `Navi 服务已就绪：${cfg.baseURL}`,
    needsSetup: `${cfg.dataDir} 里还没有数据：先打开一次 Navi 选「全新开始」。`,
  };
  const text = lines[outcome.kind] ?? (outcome.kind === "occupied" ? outcome.message : `Navi 服务没起来：${outcome.message}`);
  log(text);
  process.stdout.write(`${text}\n`);
  process.exit(outcome.kind === "ready" || outcome.kind === "needsSetup" ? 0 : 1);
}

// 日志里留下每条进出的消息（说明屏连正文）：用户说「打不开」时，靠它看出卡在哪一屏、为什么。
const brief = (text) => String(text ?? "").replace(/\s*\n\s*/g, " ⏎ ").slice(0, 600);
function describe(message) {
  if (message.type === "screen") return [message.screen.kind, message.screen.title, brief(message.screen.detail ?? message.screen.problem)].filter(Boolean).join(" ");
  if (message.type === "dialog") return [message.id, message.title, brief(message.detail), `[${message.buttons.join("|")}]`].join(" ");
  return brief(message.url ?? message.route ?? message.size ?? message.id ?? message.kind ?? "");
}
const send = (message) => {
  log(`→ ${message.type} ${describe(message)}`.trimEnd());
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const controller = createController({ cfg, send, launcher, log, loginItem: createLoginItem(cfg) });

process.on("uncaughtException", (error) => { log(`uncaught ${error.stack ?? error}`); });
process.on("unhandledRejection", (error) => { log(`unhandled ${error?.stack ?? error}`); });

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return log(`看不懂的消息：${line.slice(0, 200)}`); }
  log(`← ${message.type} ${describe(message)}`.trimEnd());
  controller.receive(message);
});
input.on("close", () => {
  controller.stop();
  process.exit(0);
});
log(`控制器起来了：${cfg.baseURL}，数据 ${cfg.dataDir}，窗口端口 ${cfg.windowPort}`);
controller.start();
