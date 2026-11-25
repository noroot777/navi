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

/** 交回注销函数：**确认处置完了才注销**（撤得早，退出那一下就没人负责它了）。 */
export function registerShutdownCleanup(resources: Cleanup["resources"], exit: Cleanup["exit"], drain?: Cleanup["drain"]): () => void {
  const cleanup = { resources, exit, drain };
  cleanups.add(cleanup);
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

/** 排空最多等这么久：够执行器的停止走完「TERM → 两秒 → KILL」再加一轮追后代，又不至于让停服务的一方等到超时。 */
export const SHUTDOWN_DRAIN_MS = 6_000;

export function shutdownDrainPending(): boolean {
  return [...cleanups].some((cleanup) => cleanup.drain);
}

/** 有要排空的就等它们（最多 `timeoutMs`）；没有就当场返回，不给平常的停服务添一点等待。 */
export async function drainShutdownCleanups(timeoutMs = SHUTDOWN_DRAIN_MS): Promise<boolean> {
  const pending = [...cleanups].flatMap((cleanup) => (cleanup.drain ? [cleanup.drain().catch(() => {})] : []));
  if (!pending.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const drained = await Promise.race([Promise.all(pending).then(() => true), timedOut]);
  clearTimeout(timer);
  return drained;
}
