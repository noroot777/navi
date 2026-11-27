// 会话里 ⌘F 查找的夹具（断言在 test-conversation-find-dom.mjs）。
//
// 主会话照任务详情那样摆：一块（FIND_SCOPE）里上面一行标题、标题行里留着查找条的空位，下面是
// 真的 ConversationScrollControls（贴底、查找条都是产品代码）。旁边摆一条侧聊那样直接挂
// ConversationFind、没留空位的小会话：⌘F 该交给哪一条、同一时间只开一条、没空位时浮着，靠它看。
// 外面用 `window.fixture` 驱动：来一段新回复、挂上 / 卸下会话、拿一层东西盖住整页。
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationFind, ConversationFindSlot } from "../../src/components/ConversationFind.tsx";
import { ConversationScrollControls } from "../../src/components/ConversationScrollControls.tsx";
import { contentVersion } from "../../src/lib/useStickToBottom.ts";
import { FIND_SCOPE } from "../../src/search/conversationFind.ts";
import "../../src/styles/global.css";

type Item = { id: string; text: string; fold?: string };

// 「编辑器」出现三次：开头、中间、结尾。「旁路通道」只在一块折好的执行过程里。
const seed: Item[] = [
  { id: "requirement", text: "原始需求：设置页里的执行模式编辑器要压成一行。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `filler-${index}`, text: `第 ${index + 1} 段：先读代码，摸清现状。` })),
  { id: "middle", text: "改为：每行前面加上对应角色的 icon——与右侧编辑器一致。" },
  { id: "process", text: "过程收起来了。", fold: "这里排查了一下旁路通道的残留进程。" },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `tail-${index}`, text: `第 ${index + 7} 段：接着干活。` })),
  { id: "last", text: "最后：编辑器那一块已经改好。" },
];

declare global {
  interface Window {
    fixture: {
      append: (text?: string) => void;
      mount: (value: boolean) => void;
      cover: (value: boolean) => void;
    };
  }
}

function Feed({ items }: { items: Item[] }) {
  const scroll = useRef<HTMLDivElement>(null);
  const tailKey = contentVersion(items, (item) => item.text.length, (item) => item.id);
  return (
    <div {...FIND_SCOPE} style={{ display: "flex", minWidth: 0, flex: 1, flexDirection: "column" }}>
    <header className="task-detail-header" data-testid="main-header">
      <span className="task-detail-title is-readonly">排查</span>
      <span className="task-head-grow" />
      <ConversationFindSlot />
      <span className="task-head-acts" data-testid="acts"><button type="button">更多</button></span>
    </header>
    <div className="conversation-scroll-region" data-testid="region" style={{ minHeight: 0, flex: 1 }}>
      <div className="task-conversation" ref={scroll} data-testid="feed">
        {items.map((item) => (
          <article key={item.id} data-item={item.id} className="task-message" style={{ minHeight: 160 }}>
            <p>{item.text}</p>
            {item.fold && (
              <details data-testid="fold">
                <summary>执行过程</summary>
                <p>{item.fold}</p>
              </details>
            )}
          </article>
        ))}
      </div>
      <ConversationScrollControls scrollRef={scroll} resetKey="t1" tailKey={tailKey} />
    </div>
    </div>
  );
}

function Side() {
  const scroll = useRef<HTMLDivElement>(null);
  return (
    <div data-testid="side-region" style={{ position: "relative", width: 240, minHeight: 0 }}>
      <div ref={scroll} data-testid="side" style={{ height: "100%", overflow: "auto", padding: 12 }}>
        <p>侧聊：编辑器这个词这里也有。</p>
      </div>
      <ConversationFind scrollRef={scroll} resetKey="side" />
    </div>
  );
}

function Fixture() {
  const [items, setItems] = useState(seed);
  const [mounted, setMounted] = useState(true);
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    window.fixture = {
      append: (text = "又来了一段新回复。") => setItems((list) => [...list, { id: `new-${list.length}`, text }]),
      mount: setMounted,
      cover: setCovered,
    };
  }, []);
  return (
    <>
      <input data-testid="outside" placeholder="会话外面的输入框" />
      <main style={{ display: "flex", width: 1000, height: 520 }}>
        {mounted && <><Feed items={items} /><Side /></>}
      </main>
      {covered && <div data-testid="cover" style={{ position: "fixed", inset: 0, zIndex: 100, background: "white" }} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
