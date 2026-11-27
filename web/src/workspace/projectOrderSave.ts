import { api } from "../lib/api.ts";

// 项目先后的保存队：页面先照排，请求排成一条队，同一时刻只有一发在途；在途时再来的只留最新一份。
// 整份顺序在服务端按到达先后覆盖，并发发出去就成了「谁晚到谁算数」，先发的旧意图晚到会盖掉最后一次调整。
//
// 每一发都有期限：等不到回音（反向代理吞了响应、网络切换而连接没断）就掐掉，接着发最新那份。掐掉的那发
// 结果未知、可能晚到，所以每发都带本页 id 和递增序号，服务端只认序号更大的（server/src/project-order.ts），
// 晚到的旧意图盖不回去。
//
// 队没排空之前 `intent()` 给出用户最后排的那份：这段时间读回来的项目列表照收（别处新建、改名的项目照样
// 出现），只是先后按它摆（useProjects 的 read）—— 列表读取从不因为保存在途而停摆。
export const ORDER_SAVE_DEADLINE_MS = 15_000;

const PAGE_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let seq = 0;

export function createOrderSaver({ onError, onSettled }: {
  // 只报最新那份意图的结果：前一份失败、后面还排着更新的，那次失败已经无关紧要。
  onError: (reason: unknown) => void;
  // 队排空（最后一份成了、或失败了）：该按服务端的真值对一次账了。
  onSettled: () => void;
}) {
  let running = false;
  let next: string[] | null = null;
  let intent: string[] | null = null;

  const send = async (projectIds: string[]) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`等了 ${ORDER_SAVE_DEADLINE_MS / 1000} 秒没有回音`)), ORDER_SAVE_DEADLINE_MS);
    seq += 1;
    try {
      await api.reorderProjects(projectIds, { page: PAGE_ID, seq }, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    intent: () => intent,
    save(projectIds: string[]) {
      intent = projectIds;
      next = projectIds;
      if (running) return;
      running = true;
      void (async () => {
        while (next) {
          const current = next;
          next = null;
          try {
            await send(current);
          } catch (reason) {
            if (!next) onError(reason);
          }
        }
        running = false;
        intent = null;
        onSettled();
      })();
    },
  };
}
