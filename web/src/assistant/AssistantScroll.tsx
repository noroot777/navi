import { useRef, type ReactNode } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import { useStickToBottom } from "../lib/useStickToBottom.ts";
import { useScrollEdges } from "../lib/useScrollEdges.ts";
import { ConversationFind } from "../components/ConversationFind.tsx";

function MessageScroll({ conversationId, tailKey, children }: { conversationId: string; tailKey: string; children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  const { resume, noteUserScrollIntent } = useStickToBottom(scroll, conversationId, tailKey);
  const { atBottom } = useScrollEdges(scroll, conversationId);
  return <div className="chat-feed-wrap">
    <div className="chat-feed assistant-scroll" ref={scroll}>{children}</div>
    <ConversationFind scrollRef={scroll} resetKey={conversationId} onReaderMove={noteUserScrollIntent} />
    {!atBottom && <button className="chat-jump" type="button" onClick={() => { resume(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }}><ArrowDown size={13} />最新消息</button>}
  </div>;
}

function StillScroll({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const scroll = useRef<HTMLDivElement>(null);
  return <div className="chat-feed-wrap">
    <div className="chat-feed assistant-scroll" ref={scroll}>{children}</div>
    <ConversationFind scrollRef={scroll} resetKey={conversationId} />
  </div>;
}

export function AssistantScroll({ conversationId, tailKey, followMessages, children }: {
  conversationId: string;
  /** 会话尾部指纹(`chatTailKey`):这个组件只拿得到 children,认不出哪条是新消息。 */
  tailKey: string;
  followMessages: boolean;
  children: ReactNode;
}) {
  return followMessages ? <MessageScroll conversationId={conversationId} tailKey={tailKey}>{children}</MessageScroll>
    : <StillScroll conversationId={conversationId}>{children}</StillScroll>;
}
