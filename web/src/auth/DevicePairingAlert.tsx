import { useEffect, useState } from "react";
import type { PairRequestView } from "@navi/shared";
import { Check, Devices, Prohibit, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { authApi } from "../lib/authApi.ts";
import { PAIR_REQUESTS_CHANGED_EVENT, seenLabel } from "../lib/pairing.ts";
import { dropPairRequest, subscribePairRequests } from "../lib/pairRequests.ts";
import { useIsLocalOnly, useIsMultiUser } from "./authContext.ts";

// 自用模式:一台新设备打开了这台 navi,等机主点头。和接力申请是同一种事(别的机器想进来,
// 得有人拍板),所以长相和落点都跟 HandoffApprovalAlert 一样,样式也用它那一套。
//
// 不用像那边一样筛「新鲜」:申请只活十分钟,过期了服务端自己就不再给。
//
// 名单是整页共用的那一份(lib/pairRequests.ts,轮询、事件流、连回来都让它重读),系统通知读的也是它
// (lib/pairNotify.ts):人不在页面跟前时,同一张申请弹成系统通知。
export function DevicePairingAlert({ notify }: { notify: (message: string) => void }) {
  // 多人模式没有设备配对(那边每个人凭自己的 key 登录),本机自用模式连别的设备都连不进来。
  const multi = useIsMultiUser();
  const localOnly = useIsLocalOnly();
  const off = multi || localOnly;
  const [requests, setRequests] = useState<PairRequestView[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (off) return;
    const unsubscribe = subscribePairRequests(setRequests);
    return () => {
      unsubscribe();
      setRequests([]);
    };
  }, [off]);

  const request = requests[0];
  if (off || !request) return null;

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      await authApi.decidePair(request.id, decision);
      dropPairRequest(request.id);
      notify(decision === "approve" ? `「${request.name}」可以用这台 Navi 了` : "已拒绝");
    } catch (error) {
      notify(error instanceof Error ? error.message : "处理失败");
    } finally {
      window.dispatchEvent(new Event(PAIR_REQUESTS_CHANGED_EVENT));
      setBusy(false);
    }
  };

  return (
    <section className="handoff-approval-alert" role="alertdialog" aria-labelledby="device-pairing-alert-title">
      <span className="handoff-approval-alert-icon"><Devices size={22} weight="fill" aria-hidden="true" /></span>
      <div className="handoff-approval-alert-copy">
        <strong id="device-pairing-alert-title">「{request.name}」想连接这台 Navi</strong>
        <p>
          它屏幕上的配对码应为 <b className="pair-code">{request.code}</b>。允许后，它能做你在这里能做的一切。
        </p>
        <small>
          来自 {request.address}{` · ${seenLabel(request.createdAt)}`}
          {requests.length > 1 ? ` · 另有 ${requests.length - 1} 个申请` : ""}
        </small>
      </div>
      <div className="handoff-approval-alert-actions">
        <Button variant="primary" disabled={busy} onClick={() => void decide("approve")}>
          {busy ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
          允许
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void decide("deny")}>
          <Prohibit size={13} aria-hidden="true" />拒绝
        </Button>
      </div>
    </section>
  );
}
