// 一口气来了好几条系统通知时合成一条（lib/systemNotify.ts 用）。
//
// 合在客户端、不合在服务端：服务端合了就只剩一条不带任务的通知，过滤器没法按收件人逐件核「这个任务你看不看得见」
// （被移出项目的成员照样收到那几个任务的标题）。到这里的每一条都已经按收件人过过滤，合出来的只会有他看得见的。
// 服务端一次对账推的几条前后脚到，攒 WINDOW_MS 再看有几条。
import type { ServerEvent } from "@navi/shared";

type Notice = Extract<ServerEvent, { type: "task.notify" }>;

/** 交给系统弹的一条。project / task 为空 = 合成的那一条，点了只把窗口拉到前面。 */
export interface Shown {
  key: string;
  title: string;
  subtitle: string;
  body: string;
  projectId: string | null;
  taskId: string | null;
}

export const WINDOW_MS = 600;
/** 超过这么多条就合成一条：重启后补上一堆、一口气跑完一批，不该叮叮叮响一串。 */
export const DIGEST_OVER = 4;

export function batchNotices(notices: Notice[]): Shown[] {
  if (notices.length <= DIGEST_OVER) {
    return notices.map((notice) => ({
      key: notice.key, title: notice.title, subtitle: notice.subtitle, body: notice.body, projectId: notice.projectId, taskId: notice.taskId,
    }));
  }
  const titles = [...new Set(notices.map((notice) => `「${notice.title}」`))];
  return [{
    key: `digest:${notices[0]!.key}:${notices.length}`,
    title: `${notices.length} 件事等你看`,
    subtitle: "",
    body: titles.length > 3 ? `${titles.slice(0, 3).join("、")} 等 ${titles.length} 个任务` : titles.join("、"),
    projectId: null,
    taskId: null,
  }];
}
