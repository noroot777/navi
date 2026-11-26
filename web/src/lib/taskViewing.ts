// 这台设备上此刻有没有哪个页面正对着看某个任务 —— 系统通知据此不弹（lib/systemNotify.ts）。
//
// 「看着」= 那个任务的会话视图挂在页面上（TaskDetail / TeamView / DuetView 挂载时登记），且这个页面在前台（可见、
// 有焦点）。认视图挂没挂，不认地址栏：切到 Git 工作台、助手、聊天时地址栏里的 task 还留着，人已经不在看它了。
//
// 几个页面（几个标签、几个窗口）各收到同一条通知，后台那几个也得知道前台那个正看着：各页面经 BroadcastChannel
// 互相报一声自己此刻在前台看着哪几个任务。页面崩掉来不及说「不看了」的，那一声过了 STALE_MS 不再算数，在前台
// 看着的页面每 BEAT_MS 重报一次。
import { useEffect } from "react";

const CHANNEL = "navi:task-viewing";
const BEAT_MS = 15_000;
const STALE_MS = 45_000;

type Message = { page: string; ask?: true; tasks?: string[] };

const page = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
/** 本页挂着的任务视图（同一个任务可能挂两处：团队页里的成员抽屉）。 */
const mounted = new Map<string, number>();
/** 别的页面上一次报来的：在前台看着哪几个、什么时候报的。 */
const others = new Map<string, { tasks: string[]; at: number }>();
let channel: BroadcastChannel | null = null;
let started = false;

const foreground = () => document.visibilityState === "visible" && document.hasFocus();
const watching = (): string[] => (foreground() ? [...mounted.keys()] : []);

function post(message: Message): void {
  try {
    channel?.postMessage(message);
  } catch {
    // 通道关了（页面正在卸下）：别的页面靠过期不再算它
  }
}

const announce = () => post({ page, tasks: watching() });

/** 开始跟别的页面互报（系统通知起来时调一次；视图登记时也会兜一下）。 */
export function startTaskViewing(): void {
  if (started) return;
  started = true;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<Message>) => {
      const data = event.data;
      if (!data || typeof data.page !== "string" || data.page === page) return;
      if (data.ask) {
        announce();
        return;
      }
      const tasks = Array.isArray(data.tasks) ? data.tasks.filter((id): id is string => typeof id === "string") : [];
      if (tasks.length) others.set(data.page, { tasks, at: Date.now() });
      else others.delete(data.page);
    };
    // 新开的页面先问一声：别的页面此刻在看什么
    post({ page, ask: true });
  }
  window.addEventListener("focus", announce);
  window.addEventListener("blur", announce);
  document.addEventListener("visibilitychange", announce);
  window.addEventListener("pagehide", () => post({ page, tasks: [] }));
  window.setInterval(() => { if (watching().length) announce(); }, BEAT_MS);
}

/** 任务视图挂着期间登记「这一页在看它」。 */
export function useViewingTask(taskId: string | null | undefined): void {
  useEffect(() => {
    if (!taskId) return;
    startTaskViewing();
    mounted.set(taskId, (mounted.get(taskId) ?? 0) + 1);
    announce();
    return () => {
      const left = (mounted.get(taskId) ?? 1) - 1;
      if (left > 0) mounted.set(taskId, left);
      else mounted.delete(taskId);
      announce();
    };
  }, [taskId]);
}

/** 这台设备上有没有哪个页面此刻在前台看着这个任务（本页或别的页）。 */
export function viewedSomewhere(taskId: string): boolean {
  if (watching().includes(taskId)) return true;
  const now = Date.now();
  for (const [id, state] of others) {
    if (now - state.at > STALE_MS) {
      others.delete(id);
      continue;
    }
    if (state.tasks.includes(taskId)) return true;
  }
  return false;
}
