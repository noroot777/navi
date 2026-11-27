import { useEffect } from "react";
import { useIsLocalOnly, useIsMultiUser } from "../auth/authContext.ts";
import { startPairNotify } from "../lib/pairNotify.ts";
import { startSystemNotify } from "../lib/systemNotify.ts";

/**
 * 整页听一份 task.notify、弹系统通知（lib/systemNotify.ts）；自用模式放开了其他设备访问时，设备申请也弹（lib/pairNotify.ts）。
 * 挂在登录之后：没登录时连不上事件流。
 */
export function SystemNotifications() {
  const pairing = !useIsMultiUser() && !useIsLocalOnly();
  useEffect(() => startSystemNotify(), []);
  useEffect(() => (pairing ? startPairNotify() : undefined), [pairing]);
  return null;
}
