// 「这次 MCP 调用到底送没送达」——补捞与重试的判据都放这儿，但**两边宽严不同**，
// 这个不对称是刻意的，别顺手统一掉。
//
// 两个消费者：
// ① `mcp/src/runtime.ts` 的 `request()`：拿到的是 Node 抛的 error code，在**自己进程里**
//    退避重试，覆盖「server 在重启、MCP 还活着」。分两档：
//    · `UNDELIVERED_NET_CODES`（ECONNREFUSED…）：根本没人监听，请求一个字节都没发出去，谁都能重试；
//    · `AMBIGUOUS_NET_CODES`（ECONNRESET、对端关闭…）：连上了又断，**可能已经执行**。只有服务端
//      按请求号记账（`server/src/request-receipts.ts`：执行过的原样回放记下的答复，执行到一半
//      被停掉的交卷端点重做、其余如实答「不确定」）时重试才不会把 `dispatch` 这类做两遍 ——
//      所以 MCP 只在见过这份服务的记账回执头之后、或者撞上的是交卷端点（`isTurnReportPath`，
//      重做一遍结果不变）时才重试这一档。
// ② `server/src/mcp-handoff.ts` 的补捞：拿到的是 agent 输出流里记下的**错误文本**
//    （"Transport closed"…），在回合结算时替 agent 重放，覆盖「MCP 进程被杀」——
//    ①那套救不了这种，因为重试的代码跟着一起死了。它可以宽到 `UNDELIVERED_PHRASES`
//    （连 ECONNRESET 这种「连上了又断、也许已送达」都算），**因为它另外叠了一层
//    `REPLAYABLE_MCP_TOOLS` 幂等白名单**：最坏情况是把同一个 stage 再写一遍。
//
// 所以：宽的那份（`isUndeliveredMcpFailure`）只有在幂等白名单的保护下才能用。谁要
// 是把它接到 ①，`dispatch` 就会被做两遍。
//
// 两边都绝不认业务错误。`HTTP 409 只能在任务正在运行时确认完成` 是 server 收到了并
// 明确拒绝，重放它等于把 server 的拒绝偷偷绕过去；`Transport closed` 才是请求压根没
// 出门。这条线划错一次的代价就是**把 server 拒绝过的动作偷偷做成**，所以下面用的是
// 短语白名单，不是「包含 error 就算」。

/**
 * 「确定没送达」里最硬的那一档：连接压根没建立起来。
 *
 * 两个消费者共用这一份（`mcp/src/index.ts` 的 RETRYABLE 就是它）。形状实测见那边的
 * 注释：Node 26 下 `http://localhost:<关闭端口>` 抛的是 AggregateError。
 */
export const UNDELIVERED_NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * 「送到了一半」：连接建立过、请求可能已经在服务端执行，然后连接断了（服务在处理中被停掉、
 * 被强杀，或者响应没写完）。undici 报对端关闭是 `UND_ERR_SOCKET`。重试它的前提见文件头 ①。
 */
export const AMBIGUOUS_NET_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/**
 * 交卷那几个端点（report_stage / complete_task / pause_task / ask_question）：把 agent 已经做出的判断
 * 写回本任务自己的状态，写同一个值，重做一遍结果不变。执行到一半被停机打断时，服务端按请求号认出来
 * 就在新服务上重做（request-receipts.ts），MCP 撞上「送到了一半」也敢重试它们。
 *
 * 跟 `REPLAYABLE_MCP_TOOLS` 比多了 `ask`：那份是回合结算时替 agent 补录，agent 早已绕过去收尾了；
 * 这里是 agent 还卡在这次调用上等答复，重做的就是它此刻要的那一个问题。
 */
const TURN_REPORT_PATH = /^(?:\/api)?\/tasks\/[^/?]+\/(?:stage|complete|pause|ask)(?:\?|$)/;
export const isTurnReportPath = (path: string): boolean => TURN_REPORT_PATH.test(path);

// 各家 CLI 在 MCP 通道断掉时写进事件流的说法。全部小写后做子串匹配。
// codex(rmcp) 实测：`tool call failed for \`navi/report_stage\`\n\nCaused by:\n    Transport closed`
//
// 注意这里比 UNDELIVERED_NET_CODES 宽：`econnreset` / `socket hang up` 严格说是
// 「连上了又断」，未必没送达。只有**叠着幂等白名单**的补捞侧能用这份（见文件头）。
const UNDELIVERED_PHRASES = [
  "transport closed",
  "transport channel closed",
  "connection closed",
  "mcp server is not connected",
  "server not connected",
  "not connected to mcp",
  "broken pipe",
  "epipe",
  "socket hang up",
  "econnreset",
];

/**
 * **navi 已经应答过**的那种失败:MCP 端拿到 navi 的非 2xx 回复,就把它写成这个形状交给 agent
 * (`mcp/src/runtime.ts` 的 `request()`、带结果的拒绝 `mcp/src/tools/monitor-results.ts` 共用)。
 * 补捞那一侧据此认「对面回过话了」—— 这是格式上的约定,不是猜正文里有没有某个词:通道真断了
 * 的时候,agent 记下的是执行器自己写的那句话,里面不会有 navi 的回复。
 */
export const answeredMcpError = (status: number, method: string, path: string, body: string): string =>
  `HTTP ${status} ${method} ${path} — ${body}`;
const ANSWERED = /HTTP [1-5]\d\d (?:GET|POST|PUT|PATCH|DELETE) \/\S* — /;
export const isAnsweredMcpError = (text: string | null | undefined): boolean => !!text && ANSWERED.test(text);

/**
 * 这次失败属于「没送达」吗——**宽口径，仅供叠了幂等白名单的补捞侧使用**。
 *
 * code 与 message 给哪个都行，两个都给就任一命中即可。
 */
export function isUndeliveredMcpFailure(input: { code?: string | null; message?: string | null }): boolean {
  if (input.code && UNDELIVERED_NET_CODES.has(input.code)) return true;
  // navi 已经应答过的拒绝,正文里写着什么都不算:它可能整段带着命令输出(随 409 交出的哨兵结果),
  // 那里出现 `ECONNRESET` 是业务内容,不是这条通道断了。
  if (isAnsweredMcpError(input.message)) return false;
  const text = (input.message ?? "").toLowerCase();
  if (!text) return false;
  if ([...UNDELIVERED_NET_CODES].some((code) => text.includes(code.toLowerCase()))) return true;
  return UNDELIVERED_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * 允许被自动重放的工具——**白名单是硬的，新增工具默认不在里面**。
 *
 * 收进来的判据是三条同时成立：
 * ① **幂等**：重复执行一次结果不变（写同一个值），所以「其实送达了、只是回执丢了」
 *    的那种情况重放也不会出事；
 * ② **只写回本任务自己的状态**：它是 agent 在回合末尾「向 navi 交卷」的动作，丢了
 *    就等于活白干（结论没写回、完成没确认）；
 * ③ **不凭空创造一个新的等待**：重放只是把 agent 已经做出的判断补录进来，不该让任务
 *    多出一个「有人在等你」的状态。
 *
 * 明确排除的两类：
 * · `dispatch` / `accept_task` / `batch_create_tasks` / `create_task_chain` / `run_task` /
 *   `stop_task` —— 违反①，每执行一次就在世界上多一个后果（多派一批执行者、**多合并一次
 *   代码**、多杀一次进程）。这类调用丢了宁可让人看见它失败，也不能替 agent 补一刀。
 * · `ask_question` —— 违反③。它跟另外三个的位置不一样：那三个是**回合终点**的交卷动作，
 *   而提问是**回合中途**的阻塞点，调用失败后 agent 通常自己绕过去继续干完了（实测的
 *   codex 就是这个行为）。事后替它把问题挂上去，等于让用户去回答一个早已被绕过的问题，
 *   答复还会 resume 一个已经收尾的会话。
 */
export const REPLAYABLE_MCP_TOOLS = new Set([
  "report_stage",
  "complete_task",
  "pause_task",
]);

export function isReplayableMcpTool(tool: string): boolean {
  return REPLAYABLE_MCP_TOOLS.has(tool);
}
