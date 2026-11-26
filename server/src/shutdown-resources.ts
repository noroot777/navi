// 随服务一起关掉的东西：终端、聊天执行、AI 协助、预览试跑、讨论起名……
//
// 每一份登记两样：给重启确认看的资源（`resources`，restart-freeze.ts 的快照）和退出时的处置。处置分两段：
//  · `drain`  收到停止信号之后、真正退出之前那一段**能 await** 的收尾（singleton.ts 的信号处理器先等它）：
//             杀掉并确认死透，收不净的交给执行器那套清理责任（executors/kill.ts 的 cleanupAfterRun）。
//             临时智能体靠的就是这一段 —— 它们的停止方法是异步的（TERM、追后代、两秒后补 KILL），
//             进了 `process.on("exit")` 那些后续一步都不会再跑，不配合 TERM 的就留在后台没人管了。
//  · `exit`   `process.on("exit")` 里那一下，只能同步：排空等超时了、或者不是走信号退出的，这是最后的兜底。
// 说了「会关掉」就得真关掉：只登记一句文案、不负责处置的写法不要有。
export type ShutdownResource = {
  kind: string;
  /** 这一份运行自己的编号，从登记到注销不变、同一 kind 下不复用：重启确认按 `kind:id` 比「多出了谁」。 */
  id: string;
  label: string;
  projectId?: string;
  pid?: number;
  ports?: number[];
};

type Cleanup = {
  resources: () => ShutdownResource[] | Promise<ShutdownResource[]>;
  exit: () => void;
  drain?: () => Promise<unknown>;
};

const cleanups = new Set<Cleanup>();
/** 登记过几次（只增不减）：排空凭它看「这一遍里有没有新进来的」。 */
let registrations = 0;

/** 交回注销函数：**确认处置完了才注销**（撤得早，退出那一下就没人负责它了）。 */
export function registerShutdownCleanup(resources: Cleanup["resources"], exit: Cleanup["exit"], drain?: Cleanup["drain"]): () => void {
  const cleanup = { resources, exit, drain };
  cleanups.add(cleanup);
  registrations += 1;
  process.once("exit", exit);
  return () => {
    cleanups.delete(cleanup);
    process.removeListener("exit", exit);
  };
}

export async function shutdownResources(): Promise<{ version: 1; resources: ShutdownResource[] }> {
  const resources = [];
  for (const cleanup of cleanups) resources.push(...await cleanup.resources());
  return { version: 1, resources };
}

export function shutdownDrainPending(): boolean {
  return [...cleanups].some((cleanup) => cleanup.drain);
}

/** 排空最多等这么久：够执行器的停止走完「TERM → 两秒 → KILL」再加一轮追后代，又不至于让停服务的一方等到超时。 */
export const SHUTDOWN_DRAIN_MS = 6_000;

export type DrainOutcome = { done: true } | { done: false; why: string; kinds: string[] };

/**
 * 有要排空的就等它们（最多 `timeoutMs`）；没有就当场返回，不给平常的停服务添一点等待。
 *
 * 调用方先关上接活（runtime-handover-state.ts 的 beginServiceShutdown），这里再一遍遍地收：每一遍取**此刻**的
 * 登记，等完再看一眼，期间又登记进来的（关闸那一刻已经过了关口、还没登记完的）下一遍接着收，直到一遍下来
 * 没有新登记。超时、或者哪份收尾自己抛了，如实交回是哪几类没收完，调用方写进退出日志。
 */
export async function drainShutdownCleanups(timeoutMs = SHUTDOWN_DRAIN_MS): Promise<DrainOutcome> {
  const deadline = Date.now() + timeoutMs;
  const failed = new Set<Cleanup>();
  for (;;) {
    const before = registrations;
    const round = [...cleanups].filter((cleanup) => cleanup.drain);
    if (!round.length) break;
    const left = deadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, left)); });
    const settled = Promise.all(round.map((cleanup) => cleanup.drain!().then(() => {}, () => { failed.add(cleanup); })));
    const result = await Promise.race([settled.then(() => "settled" as const), timedOut]);
    clearTimeout(timer);
    if (result === "timeout") {
      return { done: false, why: `超过 ${Math.round(timeoutMs / 1000)} 秒没收完`, kinds: await kindsOf([...cleanups].filter((c) => c.drain)) };
    }
    if (registrations === before) break;
  }
  return failed.size ? { done: false, why: "收尾时出错", kinds: await kindsOf([...failed]) } : { done: true };
}

async function kindsOf(list: Cleanup[]): Promise<string[]> {
  const kinds = new Set<string>();
  for (const cleanup of list) {
    try { for (const resource of await cleanup.resources()) kinds.add(resource.label || resource.kind); } catch { /* 问不出就不列 */ }
  }
  return [...kinds];
}
