import { useEffect, useState } from "react";
import { Toggle } from "../components/ui.tsx";
import {
  notifyBlocked, notifyChannel, onSystemNotifyChange, setSystemNotifyEnabled, systemNotifyEnabled,
} from "../lib/systemNotify.ts";

// 设置页里的「通知」一块：这台设备弹不弹系统通知（lib/systemNotify.ts）。按设备记，不进服务端设置 ——
// 浏览器的通知权限本来就是按设备给的。
export function SystemNotifyCard({ notify }: { notify: (message: string) => void }) {
  const [enabled, setEnabled] = useState(systemNotifyEnabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => onSystemNotifyChange(() => setEnabled(systemNotifyEnabled())), []);
  const channel = notifyChannel();
  const blocked = notifyBlocked();
  const note = channel === "none"
    ? "这个地址下浏览器不给弹通知，要用 https 或本机地址打开。"
    : blocked
      ? "浏览器拒绝了这个网站的通知，要去浏览器的网站设置里放开。"
      : "任务跑完、验收落定、没通过、中断，或停下来等你拍板时弹一条；正开着看的那个任务不弹。";

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const now = await setSystemNotifyEnabled(next);
      setEnabled(now);
      if (next && !now) notify("浏览器没给通知权限，还是关着");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-settings-anchor="system-notify">
      <h2>通知</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>系统通知</b>
            <small>{note}</small>
          </div>
          <Toggle
            label={enabled ? "已开启" : "已关闭"}
            checked={enabled}
            disabled={busy || channel === "none" || blocked}
            onChange={(checked) => void toggle(checked)}
          />
        </div>
      </div>
    </section>
  );
}
