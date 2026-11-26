// restart.mjs、stop.mjs、upgrade.mjs 共用的「让 :PORT 上的 navi 下线」那半截:问判据、等排空、
// 冻结接活再核一遍、认准监听者下刀、等端口彻底安静。两个入口只在「下线之后做什么」上不同,安全闸必须是
// 同一份 —— 停止命令要是另写一套,「问不出来就当 0」那类旧错就会在新入口上重演一遍。
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStorageEnv } from "./env.mjs";
import { dbFileIn } from "./db-file.mjs";
import { LEGACY_HTTP_HEADER_PREFIX, LEGACY_SINGLETON_LOCK_SUFFIX } from "./legacy-names.mjs";
import { IS_WINDOWS, isNotListening, killServerProcesses, listenerPids, localGet, localJson, localRequest, sleep } from "./platform.mjs";
import { RESTART_FREEZE_PATH, acquireRestartFreeze, releaseRestartFreeze, renewRestartFreeze, supportsRestartFreeze } from "./restart-freeze.mjs";

const LOCK_SUFFIX = ".navi.lock";
const HOST_TOKEN_HEADER = "x-navi-host-token";

/** 数据目录,口径跟 server/src/data-root.ts 一致:`NAVI_DATA_DIR`(旧名同样认),不设就是 `<仓库>/data`。 */
export function dataDirFor(repo, env = process.env) {
  const explicit = readStorageEnv(env, "NAVI_DATA_DIR");
  return explicit ? resolve(explicit) : join(repo, "data");
}

/**
 * server 用的库文件,口径跟 server/src/db/path.ts 一致:`NAVI_DB`(旧名 `ASH_DB` 同样认)覆盖;
 * 不然按数据目录里有什么认(scripts/db-file.mjs)。
 */
export function dbFileFor(repo, env = process.env) {
  const explicit = readStorageEnv(env, "NAVI_DB");
  if (explicit) return resolve(explicit);
  return dbFileIn(dataDirFor(repo, env));
}

/**
 * 单实例锁:server 自己写的「谁占着这个 DB」,路径口径跟 server/src/singleton.ts 一致。新版服务
 * 新旧两个名字都写(内容相同),改名之前的服务只写旧名 —— 升级那一刻对面正是它,所以哪个在就给哪个。
 */
export function lockFileFor(repo, env = process.env) {
  const db = dbFileFor(repo, env);
  return [`${db}${LOCK_SUFFIX}`, `${db}${LEGACY_SINGLETON_LOCK_SUFFIX}`].find((file) => existsSync(file))
    ?? `${db}${LOCK_SUFFIX}`;
}

/** 同一份库的退出账本(server/src/exit-ledger.ts)。 */
export const exitLedgerFor = (lockFile) =>
  `${lockFile.slice(0, lockFile.endsWith(LOCK_SUFFIX) ? -LOCK_SUFFIX.length : -LEGACY_SINGLETON_LOCK_SUFFIX.length)}.exits.jsonl`;

/**
 * 宿主机运维者的凭证:锁文件里那串 token(server 自己写的,文件 0600)。
 *
 * 多人模式下 `/api/restart-impact` 会挡住未登录请求 —— 而跑脚本的人手上没有任何网页
 * 登录态。读得到这个 token = 读得到 navi 的数据目录 = 本来就能直接读库,所以拿它当
 * 「我就是这台机器的运维者」的证明既够用也不额外扩大暴露面(server/src/singleton.ts
 * `liveLockToken`)。
 */
function hostToken(lockFile, port) {
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    return lock?.port === port && typeof lock.token === "string" ? lock.token : null;
  } catch {
    return null;
  }
}

/**
 * 带凭证的请求头。新旧两代头名各带一份:升级那一刻听着端口的是改名之前的服务,它只认旧名头
 * (`x-ash-host-token`)。新版服务两代都认、新名优先。
 */
function hostTokenHeaders(lockFile, port) {
  const token = hostToken(lockFile, port);
  if (!token) return undefined;
  return { [HOST_TOKEN_HEADER]: token, [`${LEGACY_HTTP_HEADER_PREFIX}${HOST_TOKEN_HEADER.slice("x-navi-".length)}`]: token };
}

/**
 * 「现在让 server 下线会真正打断几个任务」。**不是** running/queued 的个数 —— agent 的
 * 输出走文件之后（server/src/executors/detached.ts），单飞任务的进程压根不随 server 死，
 * 下次起来按 pid+offset 接管；团队调度台进程会断但会自动 --resume 接回。判据单点在
 * server 的 /api/restart-impact，跟真正接管时用同一条口径。
 *
 * 回答分**三档**,而不是「拿到 / 没拿到」两档:
 *  · 拿到判据          → 原样返回
 *  · `refused`         服务端答了、但不给判据(多人模式要凭证,见 hostToken)
 *  · `unknown`         **问不出来**:超时、连接被重置
 *  · `{}`              端口上压根没人在听 = server 没在跑 = 本来就没有任务会被打断
 *
 * 后两者过去被压成同一个 `{}`,于是 navi 响应慢的时候安全闸静默变成 0(第 1 轮审查 F1 / P1)。
 * **「问不出来」不等于「没有」**,所以这里把它单独报出来,由调用方 fail closed。
 */
export async function queryImpact(port, lockFile, { requireOk = false, includeShutdown = false } = {}) {
  const headers = hostTokenHeaders(lockFile, port);
  const ask = (timeoutMs) => localGet(port, `/api/restart-impact${includeShutdown ? "?shutdown=1" : ""}`, timeoutMs, headers);
  let probe = await ask(2000);
  // 慢一次不代表问不出来(这台机器往往正忙):再给一次、时限放宽。两次都没拿到仍然算 unknown。
  if (!probe.json && probe.status === null && !isNotListening(probe.error)) probe = await ask(6000);
  if (probe.json && (!requireOk || probe.status === 200)) return probe.json;
  if (probe.status !== null) return { refused: probe.status };
  if (isNotListening(probe.error)) return {};
  return { unknown: probe.error || "unknown" };
}

/**
 * 重启前冻结那条 POST 的传输（协议在 scripts/restart-freeze.mjs）：同一张宿主机凭证、同样直连本机。
 * 冻结那一下服务端要先等还在起跑的回合落定再算快照，所以时限给得比问判据宽。
 */
export function restartFreezeSender(port, lockFile) {
  const headers = hostTokenHeaders(lockFile, port);
  return (body) => localRequest(port, RESTART_FREEZE_PATH, { method: "POST", body, timeoutMs: 20_000, headers });
}

export function countOf(data, field) {
  return Array.isArray(data[field]) ? data[field].length : 0;
}

/** 服务端答了、但没给出判据。 */
export function refusedStatus(data) {
  return typeof data.refused === "number" ? data.refused : null;
}

/** 「判据问不到」时给人看的那半句话；拿到了判据就返回 null。 */
export function noVerdictReason(data) {
  const refused = refusedStatus(data);
  if (refused !== null) return `服务端回 ${refused}`;
  const unknown = typeof data.unknown === "string" ? data.unknown : null;
  return unknown === null ? null : `服务端在端口上，但没答复这条判据（${unknown}）`;
}

/** 问不到判据时,解释成因的那几行(中止与否、出路命令由调用方说)。 */
export function explainNoVerdict(data, { say, lockFile, log }) {
  if (refusedStatus(data) !== null) {
    say(`     多人模式下这条判据要宿主机凭证:确认 ${lockFile} 读得到`);
    say("     (它由 server 自己写、权限 0600;换个用户跑这个脚本就读不到了)。");
    return;
  }
  // 这一档是「它在,只是没答上来」:navi 正忙,或者真卡住了。两种都不该让脚本自己拍板下刀
  // —— 问不出保护名单的那一刀,等于拿正在跑的任务赌一把(第 1 轮审查 F1)。
  say("     它还在端口上,只是没按时答复 —— Navi 正忙,或者卡住了。");
  say("     「问不出来」不等于「没有任务会被打断」,所以这里不下刀。稍后重试;");
  say(`     真卡住了就先看日志 ${log},必要时手工 kill 掉它再重跑。`);
}

/**
 * --wait 用:轮询到「不再有会被打断的任务」为止,把「人守着等」换成「脚本替你等」。
 * `count` 每次都得走调用方的 fail-closed 判据(中途凭证失效同样会把 busy 读成 0)。
 * 等到了返回 true;超时返回 false(那句话已经说了),由调用方中止(退出码 3)。
 * `deadline`(绝对时刻,毫秒)给了就按它算超时:一次操作里要等好几轮(冻结之下又多出来、放开再等)时,
 * 每一轮耗的是同一份 WAIT_TIMEOUT,不是每轮从头算。
 */
export async function drainWait({ count, waitTimeout, deadline = waitDeadline(waitTimeout), say, verb }) {
  let n = await count();
  if (!n) return true;
  say(`  ⏳ WAIT:还有 ${n} 个任务${verb}会被打断,等它们跑完(Ctrl-C 可随时放弃)…`);
  let elapsed = 0;
  const step = 5;
  while (n > 0) {
    if (deadline !== null && Date.now() >= deadline) {
      say(`  ✕ WAIT 超时(${waitTimeout}s),仍有 ${n} 个会被打断 —— 已中止,未${verb}服务端。`);
      return false;
    }
    await sleep(step * 1000);
    elapsed += step;
    n = await count();
    if (elapsed % 60 === 0 && n > 0) say(`  ⏳ 已等 ${elapsed / 60}min,还有 ${n} 个会被打断…`);
  }
  say("  ✓ 已经没有会被打断的任务了,继续。");
  return true;
}

/** WAIT_TIMEOUT(秒,null = 不设上限)从此刻起算的截止时刻。 */
export function waitDeadline(waitTimeout) {
  return waitTimeout === null || waitTimeout === undefined ? null : Date.now() + waitTimeout * 1000;
}

/**
 * 对监听者下刀,保住活得过下线的 agent。
 *
 * 「会被接管的不受影响」在 Windows 上得自己兑现:那边没有信号,整树 `taskkill /T` 会把
 * agent 一起带走,所以把 survives 的那几棵子树点名保住(判据见 platform.mjs 的
 * killServerProcess)。这份名单是**上一时刻**的快照,只是个额外输入:真正的不变量在
 * killServerProcess 那边按进程表里的壳记号认人(第 1 轮审查 F2)。POSIX 上 SIGTERM 不级联。
 * Windows 上无法安全认人时抛错,由调用方中止。
 */
export function killListeners(pids, data, { force }) {
  const spare = Array.isArray(data.survives) ? data.survives.map((t) => t.pid) : [];
  return killServerProcesses(pids, spare, { force });
}

/**
 * 端口是否**彻底安静**。「安静」只认连接被明确拒绝:超时、连接被重置都只是「问不出来」,
 * 一个卡死的旧进程照样占着端口、照样不答(第 3 轮审查实测 EADDRINUSE)。
 * 这是唯一不依赖任何系统命令的判据 —— lsof/ss/fuser 都没装的机器上 listenerPids 是空的,
 * 旧进程原封不动,只有它能把「谎报成功」拦下来(2026-08-21 Rocky 容器)。
 */
export async function isPortQuiet(port) {
  return isNotListening((await localGet(port, "/api/health", 1000)).error);
}

export async function waitPortQuiet(port, timeoutMs = 15_000) {
  const by = Date.now() + timeoutMs;
  while (Date.now() < by && !(await isPortQuiet(port))) await sleep(200);
  return isPortQuiet(port);
}

/** 停不下来时说清现状和怎么手工确认;返回该用的退出码。 */
export async function explainStillUp(port, old, { say, lockFile }) {
  const answers = Boolean(await localJson(port, "/api/health"));
  say(answers
    ? `  ✕ :${port} 上仍有一个 Navi 在应答,没能让它下线。`
    : `  ✕ :${port} 仍被占着(连得上、但不应答),没能让它下线。`);
  if (old.length) say(`     试过 kill:${old.join(", ")} —— 它没退,或者占着端口的根本是别的进程。`);
  else say("     系统没查到谁在监听这个端口:这台机器上 lsof/ss/fuser 可能都没装。");
  say(`     手工确认它是谁:  cat ${lockFile}`);
  say("                       ps -ef | grep server/dist/index.js");
  return 1;
}

/** 随服务一起关掉的终端、聊天、AI 协助、预览试跑:不为它们中止,只如实列出来(冻结快照和续期答复里带着)。 */
export function sayClosing(say, resources) {
  const closing = Array.isArray(resources) ? resources : [];
  if (closing.length) {
    say(`  ⚠ 会随服务一起关掉 ${closing.length} 个:${closing.slice(0, 6).map((r) => r.label || r.kind).join("、")}${closing.length > 6 ? " 等" : ""}`);
  }
}

/** 同一个任务在两份名单里认不认得出来:有任务号认任务号,老服务给的条目没有就认标题。 */
const itemKey = (item) => item.id ?? item.title;

/**
 * 让 :port 上的 navi 下线 —— stop.mjs、upgrade.mjs 共用的这一整段(restart.mjs 第 2 步在两次问判据之间
 * 夹着 build,自己拼这几块)。顺序与理由同 stop.mjs 顶部:只认系统说的监听者、问不出判据就不下刀、
 * 会被挡的任务默认中止、端口彻底安静才算停了。
 *
 * 过了闸、真要下刀时先让服务冻结接活(重启前冻结,协议见 restart-freeze.mjs),闸改用冻结之下的那份快照再过一遍:
 * 冻着的时候不起新回合、新 agent,问完到停下之间它不会再变多。快照里多出了会被挡的就放开冻结、照常拦下
 * (--wait 放开再等一轮);下刀前续一次期,顺带拿此刻的名单跟快照比,冻结失效了、多出谁了都不停。中止的每条出路
 * 都先放掉冻结,停成了不用放(服务一退冻结就没了),脚本自己崩了冻结也会到期自己解。服务认这道关口却冻不了
 * (另一处正在准备重启、mac 版正在换新版服务那份交接许可占着 —— 两种冻结同一时刻只有一份)就中止,--force 例外。
 * 老版本服务不认这道关口:退回即时判据,并如实说问完到停下之间新起的任务不在名单上。
 *
 * gate 说清「什么情况下不下刀」和中止时怎么说:
 *   verb        「停止」「升级」
 *   held(data)  挡住这一次的任务清单(停止只挡接管不了的那些;升级挡一切在跑、在排队的)
 *   heldLine(n) 挡住时开头那半句
 *   tail        中止时补的那半句:动了什么、没动什么
 *   command(f)  出路命令(--wait / --force)
 *   passLine(safe, lead)  可选:放行时还有任务在跑,说一句它们会怎样
 * check:只过闸、不下刀(升级在动任何东西之前先问一遍;不冻结)。
 * abort(code) 不返回:缺省直接退出;升级要先把拉下来的代码退回去再退。
 * 返回 { running:false } 本来就没在跑;{ running:true, data } 过了闸(check)或已停干净。
 */
export async function takeDown({ port, lockFile, log, force, wait, waitTimeout, say, gate, check = false, abort = (code) => process.exit(code) }) {
  const old = listenerPids(port);
  if (!old.length) {
    if (await isPortQuiet(port)) return { running: false };
    // 查不到监听者(lsof/ss/fuser 都没装)却有人占着:只过闸时照样问判据,真要下刀时如实失败。
    if (!check) return abort(await explainStillUp(port, old, { say, lockFile }));
  }
  const send = restartFreezeSender(port, lockFile);
  let lease = null;
  const onInterrupt = () => { void letGo().finally(() => process.exit(130)); };
  /** 放掉手上的冻结:服务还活着,别让它冻到期才解。 */
  async function letGo() {
    if (!lease) return;
    const held = lease;
    lease = null;
    process.off("SIGINT", onInterrupt);
    await releaseRestartFreeze(send, held);
  }
  const stopHere = async (code) => { await letGo(); return abort(code); };
  const ask = async () => {
    const data = await queryImpact(port, lockFile);
    const why = noVerdictReason(data);
    if (why === null || force) return data;
    say(`  ✋ 问不到「${gate.verb}会打断谁」(${why}) —— 已中止,${gate.tail}`);
    explainNoVerdict(data, { say, lockFile, log });
    say(`     明知可能打断也要${gate.verb}:  ${gate.command("--force")}`);
    return abort(2);
  };
  let data = await ask();
  let held = gate.held(data);
  // 整次操作只有一份等待上限:普通判据的排空、冻结之下又多出来之后的重试,耗的都是它。
  const deadline = waitDeadline(waitTimeout);
  let retried = false;
  for (;;) {
    if (held.length && wait && !force) {
      const drained = await drainWait({ count: async () => gate.held(await ask()).length, waitTimeout, deadline, say, verb: gate.verb });
      if (!drained) return abort(3);
      data = await ask();
      held = gate.held(data);
    }
    if (held.length && !force) {
      say(`  ✋ ${gate.heldLine(held.length)} —— 已中止,${gate.tail}`);
      for (const t of held.slice(0, 8)) say(`     · ${t.title}${t.reason ? ` —— ${t.reason}` : ""}`);
      say(`     让脚本替你等它们跑完:  ${gate.command("--wait")}`);
      say(`     确定要打断:            ${gate.command("--force")}`);
      return abort(2);
    }
    if (check) return { running: true, data };
    // 问不到判据还往下走的只有 force(ask):那时连这份服务认不认冻结都不知道,force 已经说过会打断。
    if (noVerdictReason(data) !== null) break;
    if (!supportsRestartFreeze(data)) {
      say("  ⚠ 这一版服务端没有重启前冻结:判据是即时问的,问完到停下之间新起的任务不在上面,仍可能被打断。");
      break;
    }
    const got = await acquireRestartFreeze(send);
    if (got.kind !== "frozen") {
      if (!force) {
        say(`  ✋ 冻结不了接活(${got.why}) —— 已中止,${gate.tail}`);
        say(`     稍后重跑一次;明知新起的任务可能被打断也要${gate.verb}:  ${gate.command("--force")}`);
        return abort(2);
      }
      say(`  ⚠ FORCE:冻结不了接活(${got.why}),按即时判据${gate.verb} —— 这期间新起的任务也会被打断。`);
      break;
    }
    lease = got.lease;
    process.once("SIGINT", onInterrupt);
    data = got.impact;
    held = gate.held(data);
    if (!held.length || force) break;
    // 冻结之下多出了会被挡的(冻结那一刻还在起跑的那种):放开冻结,回到上面拦下,或者 --wait 再等一轮。
    await letGo();
    if (wait) {
      // 普通判据看不到它们(只在冻结快照里),排空那一步会立刻放行:隔一会儿再冻,别空转着反复冻结整份服务。
      if (deadline !== null && Date.now() >= deadline) {
        say(`  ✕ WAIT 超时(${waitTimeout}s),冻结之下仍有 ${held.length} 个会被挡下 —— 已中止,${gate.tail}`);
        for (const t of held.slice(0, 8)) say(`     · ${t.title}${t.reason ? ` —— ${t.reason}` : ""}`);
        return abort(3);
      }
      if (!retried) say(`  ⏳ WAIT:冻结之下还有 ${held.length} 个会被挡下(正在起跑或正在操作工作区),过一会儿再试…`);
      retried = true;
      await sleep(5000);
    }
  }
  const safe = countOf(data, "survives");
  const lead = countOf(data, "resumes");
  if ((safe > 0 || lead > 0) && gate.passLine) say(gate.passLine(safe, lead));
  const busy = countOf(data, "interrupted");
  if (busy > 0) say(`  ⚠ FORCE:打断 ${busy} 个**接管不了**的任务(判为 failed,可重试);会被接管的不受影响。`);
  // 下刀前最后核一次冻结还在(顺带续期):判据只在冻着的时候算数。续期带回此刻的名单 —— 已经在跑的 agent 自己变出的
  // 新影响服务端冻不住(server/src/restart-freeze.ts 顶部),多出了会被挡的就不停。
  if (lease) {
    const renewed = await renewRestartFreeze(send, lease);
    const known = new Set(held.map(itemKey));
    const extra = renewed.valid ? gate.held(renewed.impact).filter((t) => !known.has(itemKey(t))) : [];
    if (!renewed.valid || (extra.length && !force)) {
      say(renewed.valid
        ? `  ✋ 冻结之后又多了 ${extra.length} 个会被挡下的任务 —— 已中止,${gate.tail}重跑一次即可。`
        : `  ✋ ${renewed.why} —— 判据不再算数,已中止,${gate.tail}重跑一次即可。`);
      for (const t of extra.slice(0, 8)) say(`     · ${t.title}${t.reason ? ` —— ${t.reason}` : ""}`);
      return stopHere(2);
    }
    if (extra.length) say(`  ⚠ FORCE:冻结之后又多了 ${extra.length} 个会被挡下的任务,一并打断。`);
    data = renewed.impact;
    sayClosing(say, data.shutdown?.resources);
  }
  let how = "signal";
  try {
    how = killListeners(old, data, { force });
  } catch (error) {
    say(`  ✋ 无法安全终止 Windows 实例: ${error.message}。已中止,${gate.tail}`);
    say(`     未授权整树强杀;确定接受任务中断才使用 ${gate.command("--force")}。`);
    return stopHere(2);
  }
  if (IS_WINDOWS && safe > 0 && how !== "selective") {
    say(`  ⚠ 这一刀走的是整树强杀(taskkill /T),${safe} 个本可接管的任务会跟着断 ——`);
    say("     只有问得到判据(survives 名单)时才能点名保住它们。");
  }
  // 它没退:还冻着就放开,别让它带着冻结接着跑到期。
  if (!(await waitPortQuiet(port))) return stopHere(await explainStillUp(port, old, { say, lockFile }));
  // 停成了:服务一退冻结跟着没了,不用放。
  lease = null;
  process.off("SIGINT", onInterrupt);
  return { running: true, data };
}
