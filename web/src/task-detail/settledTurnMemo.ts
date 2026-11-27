// 会话里那颗智能体气泡（ConversationFeed 的 AgentMessage）什么时候不必重画。从 ConversationFeed 拆出来：
// 判据要能单独测，而那份组件一加载就带上整套浏览器运行时。
import type { ReactNode } from "react";
import type { DraftingEvent } from "@navi/shared";
import type { ConversationItem } from "./conversationModel.ts";
import type { ReviewLaneMessageRole } from "./conversationReviewLanes.ts";
import type { TurnReceipt } from "./conversationSystemRows.ts";
import { receiptsKey } from "./turnFootnote.ts";

/** 气泡的 props 里参与比较的那几项（与 ConversationFeed 的 AgentMessageView 同形）。 */
export type AgentMessageProps = {
  item: Extract<ConversationItem, { kind: "agent" }>;
  taskId: string;
  hideTime?: boolean;
  laneRole?: ReviewLaneMessageRole;
  onFork?: () => void;
  onAskSideChat?: (quote: string) => void;
  wakeReply?: boolean;
  taskActive: boolean;
  receipts?: readonly TurnReceipt[];
  footnote?: { node: ReactNode; key: string };
  drafting?: DraftingEvent | null;
};

/**
 * 已经收口的回合不跟着别人的事件重渲。会话每来一条
 * 事件，整份条目都会重新拼一遍、每一条都是新对象；还在说的那一回合要跟着变，说完的那些只在
 * 它自己真的变了时才重画（重读回来补上了执行过程、被删了一截、旁边多了回执）。回调只认有没有：
 * 它们闭包里拿的都是稳定的 setter / 派发函数。
 */
export function sameSettledTurn(prev: AgentMessageProps, next: AgentMessageProps): boolean {
  if (prev.item === next.item && prev.taskActive === next.taskActive) return shallowRest(prev, next);
  const settled = (props: AgentMessageProps) => !!props.item.endedAt || !props.taskActive;
  if (!settled(prev) || !settled(next)) return false;
  const a = prev.item;
  const b = next.item;
  return a.id === b.id && a.endedAt === b.endedAt && a.markdown === b.markdown && a.label === b.label && a.agentType === b.agentType
    && sameSegments(a.segments, b.segments)
    && a.continuation === b.continuation && a.wokenByMonitor === b.wokenByMonitor && a.resumeCause?.reason === b.resumeCause?.reason
    && a.reviewer?.round === b.reviewer?.round && a.run?.model === b.run?.model && a.run?.reasoningEffort === b.run?.reasoningEffort
    && sameJson(a.sources, b.sources) && sameJson(a.usage, b.usage) && a.session?.exitStatus === b.session?.exitStatus
    && shallowRest(prev, next);
}

/**
 * 段落比内容，不比条数：重读回来的同一回合，工具详情、附件路径、配对的那份拷贝可能换了而条数
 * 不变（第 1 轮审查）。逐项比一遍远比重画这一回合便宜。
 */
function sameSegments(left: AgentMessageProps["item"]["segments"], right: AgentMessageProps["item"]["segments"]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index]!;
    return segment === other || (segment.id === other.id && segment.markdown === other.markdown && segment.awaiting === other.awaiting
      && segment.attachments.join("\n") === other.attachments.join("\n")
      && sameJson(segment.attachmentSources, other.attachmentSources)
      && segment.events.length === other.events.length
      && segment.events.every((event, at) => {
        const twin = other.events[at]!;
        return event === twin || (event.kind === twin.kind && event.label === twin.label && event.detail === twin.detail
          && event.at === twin.at && sameJson(event.nativeWork, twin.nativeWork));
      }));
  });
}

const sameJson = (left: unknown, right: unknown) => left === right || JSON.stringify(left) === JSON.stringify(right);

function shallowRest(prev: AgentMessageProps, next: AgentMessageProps): boolean {
  return prev.taskId === next.taskId && prev.hideTime === next.hideTime && prev.laneRole === next.laneRole
    && prev.wakeReply === next.wakeReply && prev.taskActive === next.taskActive
    && !!prev.onFork === !!next.onFork && !!prev.onAskSideChat === !!next.onAskSideChat
    // 记录与尾注比的是摆出来的全部内容（含记录里那几轮审查晚到的身份、报告、附言），不只条数。
    && receiptsKey(prev.receipts) === receiptsKey(next.receipts)
    && prev.footnote?.key === next.footnote?.key
    // 正在生成的那一步单独来、条目本身不变（useConversation 不为它重拼会话），比的就是它自己。
    && prev.drafting === next.drafting;
}
