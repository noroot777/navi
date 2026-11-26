import { useEffect } from "react";
import { startSystemNotify } from "../lib/systemNotify.ts";

/** 整页听一份 task.notify、弹系统通知（lib/systemNotify.ts）。挂在登录之后：没登录时连不上事件流。 */
export function SystemNotifications() {
  useEffect(() => startSystemNotify(), []);
  return null;
}
