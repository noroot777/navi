// 与 navi server 说话的那一层：地址、回合身份、连不上时的退避重试，以及把结果包成
// MCP 响应的两个壳。从 index.ts 拆出来的动机是**职责**不是行数：工具注册表会一直长
// （每加一个 navi 能力就多一段），而这一层是恒定的；混在一起时，改一句工具描述也要把
// 整份传输层重新读一遍。
//
// 这里不含任何业务判断 —— 业务全在 navi 的 HTTP 端点上（见 index.ts 顶部那段）。
import { randomUUID } from "node:crypto";
import { readEnv } from "@navi/shared/env-names";
import { NAVI_HEADERS } from "@navi/shared/http-headers";
import { AMBIGUOUS_NET_CODES, answeredMcpError, UNDELIVERED_NET_CODES } from "@navi/shared/mcp-delivery";
import { resolveTurnIdentity } from "./turn-identity.js";

export const BASE = (readEnv(process.env, "NAVI_URL") ?? "http://localhost:4317").replace(/\/+$/, "");

// 回合身份(任务 id + 回合令牌 + 方向令牌)从哪几条通道来、带了回合指纹时怎么挑,见 turn-identity.ts。
// 对不上指纹时 `IDENTITY_REFUSAL` 非空,main.ts 据此拒绝启动。
const identity = resolveTurnIdentity(process.env);
export const SOURCE_TASK_ID = identity.taskId;
export const TURN_TOKEN = identity.turnToken;
export const DIRECTION_TOKEN = identity.directionToken;
export const IDENTITY_REFUSAL = identity.refused;

// 本机流量一律不走代理。Node 24+ 在 NODE_USE_ENV_PROXY=1(或显式 HTTP_PROXY)下
// **连 localhost 也走代理** —— 实测本机 http_proxy=127.0.0.1:7897 时,打给
// navi 的每一次工具调用都先绕到代理再回来。两个后果:①白白多一跳、还把
// navi 的存活绑在代理上;②server 重启时拿到的是代理给的 UND_ERR_SOCKET
// (「对端关闭」)而不是 ECONNREFUSED,下面那个「确定没送达才重试」的判断就永远
// 命中不了。合并而不是覆盖已有的 NO_PROXY,别把用户自己的配置吃掉。
// 必须在第一次 fetch 之前执行 —— 放模块顶层即可(工具调用都在之后)。
{
  const loopback = ["localhost", "127.0.0.1", "::1"];
  const existing = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...loopback])].join(",");
  process.env.NO_PROXY = merged;
  process.env.no_proxy = merged;
}

// 重启窗口的等待上限：要盖住一次正常重启 —— 旧服务排空在途请求（最多 6s，server/src/shutdown-resources.ts
// 的 SHUTDOWN_DRAIN_MS）、停服务的一方等端口安静（scripts/server-control.mjs 最多 15s）、新服务起来到
// 应答（restart.mjs 的 START_TIMEOUT 默认 30s，初始化期间答「未执行」的 503）。90s 是这三段再留余量。
export const RECONNECT_WINDOW_MS = Number(readEnv(process.env, "NAVI_RECONNECT_MS") ?? 90_000);

// 从 Node 抛的错误里取网络错误码，只在 `codes` 里的才算。
//
// 码表来自 shared,跟 server 那边「回合结算时补捞漏掉的交卷」是同一份口径
// (`shared/src/mcp-delivery.ts`)。注意那边另有一份**更宽**的判据
// (`isUndeliveredMcpFailure`,连错误文本都认)——那份只在幂等白名单
// 的保护下才成立,**不能搬到这里**。
//
// 形状实测(Node 26):`http://localhost:<关闭端口>` 抛 AggregateError,code 挂在
// AggregateError 自己身上、errors 里是 IPv4/IPv6 各一条;`http://127.0.0.1:…`
// 抛普通 Error。两种都要认。读响应体时断开抛的是 `TypeError: terminated`,码同样挂在 cause 上。
function codeIn(e: unknown, codes: ReadonlySet<string>): string | null {
  const cause = (e as { cause?: unknown })?.cause;
  const code = (cause as { code?: string })?.code;
  const inner = (cause as { errors?: Array<{ code?: string }> })?.errors;
  if (inner?.length) return inner.every((entry) => entry?.code && codes.has(entry.code)) ? inner[0].code ?? null : null;
  return code && codes.has(code) ? code : null;
}

// 「明确没送达」:ECONNREFUSED = 根本没人在监听那个端口(server 重启期间的确切表现),请求一个字节都
// 没发出去;NAVI_RUNTIME_UNDELIVERED = 服务答了「没执行」(换运行时、正在停止、还在初始化)。谁都能重试。
export function retryableCode(e: unknown): string | null {
  if ((e as { cause?: { code?: string } })?.cause?.code === "NAVI_RUNTIME_UNDELIVERED") return "NAVI_RUNTIME_UNDELIVERED";
  return codeIn(e, UNDELIVERED_NET_CODES);
}

// 「送到了一半」:连上了又断,可能已经执行。重试它要服务端按请求号记账才不会做两遍(见下面 `request`)。
export function ambiguousCode(e: unknown): string | null {
  return codeIn(e, AMBIGUOUS_NET_CODES);
}

// 这份服务记的是哪一本账(server/src/request-receipts.ts):带请求号的答复都带着账本号,随库走。
// `undefined` = 还不知道,`null` = 对面不记账(老版本服务)。
//
// 每一次写调用**开发之前**就绑定它记在哪本账上(`expected`),之后只认这一个,不认别的调用后来改写的全局值
// (第 2 轮审查 N1:并发的读请求拿到换库后的账本号,会让断在半路的那一次以为对面还是原来那本)。绑定的账本号随
// 请求头发过去,服务端账本对不上就不执行(换了库);老版本服务不认这个头,所以重发之前另外先问一次对面记不记账。
let ledger: string | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseHeaders = (requestId: string): Record<string, string> =>
  ({ [NAVI_HEADERS.client]: "mcp", [NAVI_HEADERS.requestId]: requestId });

/** 问一次对面记的是哪本账:`null` = 不记账,`undefined` = 这会儿没人答(在重启、在初始化)。 */
async function askLedger(): Promise<string | null | undefined> {
  try {
    const res = await fetch(`${BASE}/api/health`, { headers: baseHeaders(randomUUID()) });
    await res.body?.cancel();
    if (res.status === 503 && res.headers.get("x-navi-undelivered") === "runtime-handoff-v1") return undefined;
    return res.headers.get(NAVI_HEADERS.requestReceipt);
  } catch (e) {
    return retryableCode(e) || ambiguousCode(e) ? undefined : null;
  }
}

/** 一直问到有人答,或者到 deadline(返回 `undefined`)。没人答是等待,不是「问过了」(第 2 轮审查 F2)。 */
async function waitLedger(deadline: number): Promise<string | null | undefined> {
  for (let delay = 400; ;) {
    const seen = await askLedger();
    if (seen !== undefined) return seen;
    if (Date.now() >= deadline) return undefined;
    console.error(`[navi-mcp] 账本号暂时问不到 — server 可能在重启，${delay}ms 后再问`);
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, 5_000);
  }
}

// One place to talk to the API. Network failures get a human hint; HTTP errors
// surface the server's JSON error body verbatim so the agent can react.
//
// 连不上时会**退避重试**到 RECONNECT_WINDOW_MS 为止,而不是当场抛错。理由:
// agent 进程现在能活过 server 重启(输出走文件不走管道),但它汇报成果的
// `complete_task` 走 HTTP —— 正好撞上重启那几秒就会硬失败,于是「进程活下来了、
// 成果却丢了」。重试把这个窗口抹平。
//
// 每次调用带一个请求号,重试原样带上。「送到了一半」(服务在处理中被停掉)的读请求照常重试;写请求只在它绑定
// 了一本账、而且每次重发之前问过对面还是那本账时才重发(见 `ledger`)。不重发时如实说「不确定执行了没有」,
// 不说成连不上。
async function request(method: string, path: string, body: unknown, directionToken: string): Promise<string> {
  const deadline = Date.now() + RECONNECT_WINDOW_MS;
  const requestId = randomUUID();
  const write = method !== "GET";
  let lastCode = "";
  const unreachable = (e?: unknown) => new Error(
    `连不上 Navi server (${BASE})${lastCode ? `（已重试 ${Math.round(RECONNECT_WINDOW_MS / 1000)}s，${lastCode}）` : ""}，`
    + `确认它在运行（npm start）。${e ? `原始错误：${e instanceof Error ? e.message : String(e)}` : ""}`,
  );
  // 头一次写之前先拿到账本号:不然断在半路时这一次没有凭据可核对,只能报不确定。
  if (write && ledger === undefined) {
    const seen = await waitLedger(deadline);
    if (seen === undefined) { lastCode = "账本号问不到"; throw unreachable(); }
    ledger ??= seen;
  }
  let expected = write ? ledger ?? null : null;
  let rebound = false;
  let delay = 400;
  // 有一次断在半路就记下：之后哪怕一直连不上，也不能说成「没执行」。
  let halfway = "";
  let res: Response;
  let text: string;
  const unknown = (why: string, e?: unknown) => new Error(
    `Navi server (${BASE}) 在处理这次请求时断开了连接（${halfway}）${why}，不确定它执行了没有：`
    + "先核对现状（如 get_task）再决定要不要重做。" + (e ? `原始错误：${e instanceof Error ? e.message : String(e)}` : ""),
  );
  for (;;) {
    // 断在半路之后的每一次重发(中间撞上的是连不上也一样:连上的可能已经是另一份服务)都先核对账本。
    if (halfway && write) {
      const seen = expected ? await waitLedger(deadline) : null;
      if (!expected || seen !== expected) {
        throw unknown(expected ? "，重试打到的服务不是记着这次调用的那一份（没起来、换了版本或换了库），没有替你重发" : "");
      }
    }
    try {
      const headers = baseHeaders(requestId);
      if (body !== undefined) headers["content-type"] = "application/json";
      if (SOURCE_TASK_ID) headers[NAVI_HEADERS.sourceTaskId] = SOURCE_TASK_ID;
      if (TURN_TOKEN) headers[NAVI_HEADERS.turnToken] = TURN_TOKEN;
      if (directionToken) headers[NAVI_HEADERS.directionToken] = directionToken;
      if (expected) headers[NAVI_HEADERS.requestLedger] = expected;
      res = await fetch(`${BASE}/api${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 503 && res.headers.get("x-navi-undelivered") === "runtime-handoff-v1") {
        await res.body?.cancel();
        throw new Error("服务正在切换或停止，请求未执行", { cause: { code: "NAVI_RUNTIME_UNDELIVERED" } });
      }
      const seen = res.headers.get(NAVI_HEADERS.requestReceipt);
      if (seen) ledger = seen;
      // 对面换了一本账、没有执行这一次(server/src/request-receipts.ts 的 WRONG_LEDGER):还没断过的话,这一次在哪
      // 都没执行过,改绑到新的那本重发;断过的话原来那次执行没执行不确定,照服务端那句话报给调用方。
      if (res.status === 409 && seen && expected && seen !== expected && !halfway && !rebound) {
        await res.body?.cancel();
        expected = seen;
        rebound = true;
        continue;
      }
      // 读响应体也在重试圈里:服务在写响应那一下被停掉,断在这里跟断在发请求时是同一种「送到了一半」。
      text = await res.text();
      break;
    } catch (e) {
      const half = ambiguousCode(e);
      if (half) halfway = half;
      const code = retryableCode(e) ?? (half && (!write || expected) ? half : null);
      if (!code || Date.now() >= deadline) {
        if (halfway) throw unknown(lastCode ? `（已重试 ${Math.round(RECONNECT_WINDOW_MS / 1000)}s，${lastCode}）` : "", e);
        throw unreachable(e);
      }
      lastCode = code;
      // stderr 才是 MCP 的日志通道(stdout 是协议帧,写脏了会直接搞崩会话)。
      console.error(`[navi-mcp] ${code} — server 可能在重启，${delay}ms 后重试 ${method} ${path}`);
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 5_000);
    }
  }
  // 原文另挂在 `body` 上:个别工具要从拒绝里取结构化内容(如随拒绝一起交出的哨兵结果),
  // 这时它得用同一个「已应答」形状重新写一遍(见 shared 的 `answeredMcpError`)。
  if (!res.ok) {
    throw Object.assign(new Error(answeredMcpError(res.status, method, path, text)),
      { body: text, status: res.status, method, path });
  }
  return text;
}

/** JSON 端点。解析不出来就把原文给回去 —— 兼容早年几个返回裸文本的端点。 */
export async function call(method: string, path: string, body?: unknown, directionToken = DIRECTION_TOKEN): Promise<unknown> {
  const text = await request(method, path, body, directionToken);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * **原样**取一个 text/plain 端点的响应体,不经过 JSON。
 *
 * 为什么非得另开一个:`call` 对所有成功响应都先试 `JSON.parse`,而会话正文
 * (`/sessions/:id/output`,服务端用 `c.text()` 发的)偶尔**恰好是一段合法 JSON** ——
 * agent 刚写完 `null` 或 `"某个结果"`、进程还没结束(此时末尾还没有 agentEnd 哨兵,
 * 整份正文就是那一个字面量)。于是 `null` 被解析成 JS null、当成「这条会话还没有落下
 * 任何正文」报给调用方,`"某个结果"` 则悄悄掉了一对引号。正文是**原文**,一个字节都
 * 不该被解码改写。重连退避与 HTTP 错误处理共用同一段,不另抄一份。
 */
export async function callText(path: string, directionToken = DIRECTION_TOKEN): Promise<string> {
  return request("GET", path, undefined, directionToken);
}

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
export const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// 从 shared 派生,别在这里另抄一张名单:AGENT_TYPES 加一个 CLI,MCP 工具的
