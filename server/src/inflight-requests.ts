// 正在处理的 /api 请求：从进门（过了 runtime-handover-gate.ts 那道闸）到响应交给内核为止。
//
// 两处要等它们清零：mac 换运行时封口之前（runtime-handover-prepare.ts），和服务为停止而退出之前
// （singleton.ts 的 drainBeforeExit）。只等到处理函数返回不够：响应体还在往套接字里写的时候进程一退，
// 调用方拿到的是「连接被重置」，执行过的事它不知道。响应流（事件推送那种）不算在途，它们本来就跟着
// 服务一起断，等也等不完。
//
// 不碰库也不引别的模块：singleton.ts 在开库之前就要加载它。
export type InFlightRequest = { method: string; path: string; startedAt: number };

const live = new Set<InFlightRequest>();

/** 登记一个请求；交回的函数在它处理完（响应写完或连接断了）时调，调几次都只算一次。 */
export function beginRequest(method: string, path: string): () => void {
  const entry = { method, path, startedAt: Date.now() };
  live.add(entry);
  return () => { live.delete(entry); };
}

export function inFlightRequests(): InFlightRequest[] {
  return [...live];
}

/** 等到没有在途请求，最多 `timeoutMs`；到点还没处理完的如实交回。 */
export async function waitInFlightRequests(timeoutMs: number): Promise<{ done: true } | { done: false; left: InFlightRequest[] }> {
  const until = Date.now() + timeoutMs;
  while (live.size && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  return live.size ? { done: false, left: [...live] } : { done: true };
}

/** 退出日志里的那一句：哪几个请求、各处理了多久。 */
export function describeInFlight(left: InFlightRequest[]): string {
  const now = Date.now();
  return left.map((entry) => `${entry.method} ${entry.path}（已 ${Math.round((now - entry.startedAt) / 1000)}s）`).join("、");
}
