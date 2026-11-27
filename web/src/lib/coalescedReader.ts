// 轮询类读取的单飞：同一时刻只有一次读在路上，期间再来的刷新信号（定时轮询、事件、回到可见）合成「这次读完再读一次」。
//
// 不用「每次发起都作废前一次」那种代次：那样只要每次读都比轮询间隔慢，每个读回来的结果都已经被下一次作废，界面就永远
// 停在旧样子（网络稍慢、服务正忙时就是这样）。刷新信号只该让结果更新，不该让在路上的结果作废。
//
// 真正让在路上的结果作废的只有调用方明说的那几件事（`invalidate`）：本页刚做成一次写（处理掉一张申请、移除一台设备），
// 写之前发出的读带回来的是旧的。被作废的那次读完自动再读一次。读挂住不回的按超时算失败，不拖住后面的读。
const TIMEOUT_MS = 15_000;

export interface CoalescedReader {
  /** 读一次（已经有一次在路上就排一次「读完再读」）。 */
  reload(): void;
  /** 在路上的那次读作废：它的结果不落，读完再读一次。 */
  invalidate(): void;
  /** 不再读：在路上的结果不落，排着的不再读。 */
  close(): void;
}

export function coalescedReader<T>(read: () => Promise<T>, apply: (value: T) => void): CoalescedReader {
  let inflight = false;
  let again = false;
  let generation = 0;
  let closed = false;

  const run = (): void => {
    if (closed) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    const mine = generation;
    let timer = 0;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    void Promise.race([read(), timeout])
      .then((value) => {
        if (closed) return;
        if (mine === generation) apply(value);
        else again = true;
      }, () => {
        // 读失败 / 超时：下一次刷新信号再读（轮询保证会来）
      })
      .finally(() => {
        window.clearTimeout(timer);
        inflight = false;
        if (again && !closed) {
          again = false;
          run();
        }
      });
  };

  return {
    reload: run,
    invalidate() {
      generation += 1;
    },
    close() {
      closed = true;
      generation += 1;
    },
  };
}
