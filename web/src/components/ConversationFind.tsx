import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretUp, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { FIND_SLOT, clearFind, conversationScope, findSlotFor, paintFind, registerConversationFinder } from "../search/conversationFind.ts";
import { findOccurrences, revealOccurrence, type SearchOccurrence } from "../search/searchReveal.ts";

/** 单字查询在长会话里能有上万处：数到这里为止，计数写成「N+」。 */
const MAX_FOUND = 5_000;
/** 会话还在长时多久重数一次：每出一个字就把整条会话的文字过一遍太贵。 */
const RECOUNT_GAP_MS = 200;
/** 打开一层折叠之后等它画完再量：onToggle → 状态 → 重画是异步的，旧的 Range 可能已经作废。 */
const UNFOLD_SETTLE_MS = 60;

/** 一处出现在屏幕上的位置；在关着的折叠块里时，用最外层那块看得见的折叠条代替。 */
const placeOf = (occurrence: SearchOccurrence) =>
  (occurrence.closed.at(-1) ?? occurrence.range).getBoundingClientRect();

/**
 * 一条会话的查找条（⌘F，见 search/conversationFind.ts）。平时不画，按了 ⌘F 才出来：停在这条会话
 * 所在那一块的标题行空位里（`ConversationFindSlot`），没有空位就浮在会话右上角。开着时：
 * 打字就找、标出每一处并落到第一处；回车 / ⌘G 下一处，⇧回车 / ⇧⌘G 上一处，Esc 关（走 useDismissable）。
 *
 * - 找的是此刻 DOM 里的字（跟浏览器的查找一样），所以会话还在长时会跟着重数，但不会把人拽走：
 *   只有打字和跳转才挪视口，而且挪之前先让贴底逻辑别再跟随（`onReaderMove`）。
 * - 关着的折叠块（执行过程）里的字也算数；跳到那一处时先把它打开。
 * - 换一条会话（`resetKey`）就收起来：上一条的命中留着没有意义。
 */
export function ConversationFind({
  scrollRef,
  resetKey,
  extraRoots,
  onReaderMove,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  resetKey: string | number | null | undefined;
  /** 滚动容器之外、同样属于这条会话正文的区域（duet 顶上的议题）。 */
  extraRoots?: readonly RefObject<HTMLElement | null>[];
  /** 跳过去之前通知贴底逻辑「读者接手了」，否则下一条新消息又把人拽回底部。 */
  onReaderMove?: (detachFromBottom: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [tally, setTally] = useState({ index: -1, count: 0, capped: false });
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<Element | null>(null);
  const composing = useRef(false);
  /** `root`：在第几块正文里（会话流、议题……），配合 `start` 在那一块全文里的位置认出「同一处」。 */
  const found = useRef<(SearchOccurrence & { root: number })[]>([]);
  const current = useRef(-1);
  const owner = useRef({});
  const extras = useRef(extraRoots);
  extras.current = extraRoots;
  const readerMove = useRef(onReaderMove);
  readerMove.current = onReaderMove;
  const openRef = useRef(open);
  openRef.current = open;
  const queryRef = useRef(query);
  queryRef.current = query;
  const settle = useRef(0);
  const reopened = useRef(false);

  const roots = useCallback(() => [
    ...(extras.current ?? []).flatMap((root) => root.current ? [root.current] : []),
    ...(scrollRef.current ? [scrollRef.current] : []),
  ], [scrollRef]);

  const paint = useCallback(() => {
    const list = found.current;
    const target = list[current.current];
    paintFind(owner.current, list.filter((occurrence) => !occurrence.closed.length).map((occurrence) => occurrence.range),
      target && !target.closed.length ? target.range : null);
    setTally({ index: current.current, count: list.length, capped: list.length >= MAX_FOUND });
  }, []);

  const recount = useCallback(() => {
    const needle = queryRef.current;
    found.current = needle.trim()
      ? roots().flatMap((root, index) => findOccurrences(root, [needle], MAX_FOUND).map((occurrence) => ({ ...occurrence, root: index })))
      : [];
  }, [roots]);

  /** 落到第 index 处：在折叠块里就先打开、等它画完重量一次再落。 */
  const land = useCallback((index: number) => {
    window.clearTimeout(settle.current);
    current.current = index;
    const target = found.current[index];
    if (!target) return paint();
    if (target.closed.length) {
      target.closed.forEach((fold) => { fold.open = true; });
      paint();
      settle.current = window.setTimeout(() => {
        recount();
        current.current = Math.min(index, found.current.length - 1);
        const unfolded = found.current[current.current];
        // 折叠块打开了字却还是看不见（内容是打开后才画的那种）：停在这一处，不再往里钻。
        if (unfolded && !unfolded.closed.length) {
          readerMove.current?.(true);
          revealOccurrence(unfolded);
        }
        paint();
      }, UNFOLD_SETTLE_MS);
      return;
    }
    readerMove.current?.(true);
    revealOccurrence(target);
    paint();
  }, [paint, recount]);

  const step = useCallback((direction: 1 | -1) => {
    const count = found.current.length;
    if (!count) return;
    land(((current.current < 0 ? (direction > 0 ? -1 : 0) : current.current) + direction + count) % count);
  }, [land]);

  /** 新的查询：从视口顶上往下第一处看得见的开始（跟浏览器一样从你正在看的地方找起）。 */
  const searchFresh = useCallback(() => {
    recount();
    const list = found.current;
    if (!list.length) {
      current.current = -1;
      return paint();
    }
    const top = scrollRef.current?.getBoundingClientRect().top ?? 0;
    const visible = list.map((occurrence, index) => ({ occurrence, index })).filter(({ occurrence }) => !occurrence.closed.length);
    // 打字的每一下都不去翻折叠块：看得见的里面有就落在看得见的，一处都没有才去打开。
    const pool = visible.length ? visible : list.map((occurrence, index) => ({ occurrence, index }));
    const below = pool.find(({ occurrence }) => placeOf(occurrence).bottom >= top);
    land((below ?? pool[0]!).index);
  }, [land, paint, recount, scrollRef]);

  /** 会话自己变了（新回复、折叠开合）：重数，当前那一处尽量不变，视口不动。 */
  const searchKeep = useCallback(() => {
    const before = found.current[current.current];
    const previous = before?.range;
    const previousIndex = current.current;
    recount();
    const list = found.current;
    let index = -1;
    if (before && previous && list.length) {
      // 旧的 Range 是活的：前面插进来新节点它跟着挪，认它最准。可它所在的文本节点被整段改写
      // （流式回复往同一个节点里续字，React 直接换 nodeValue）时，它会塌回节点开头 —— 再拿它比，
      // 当前那一处就会跳回这一段里更早的一处。塌了就改认「同一块正文里、同一个位置往后的第一处」：
      // 续字只往后长，前面的位置不变。
      index = previous.collapsed
        ? list.findIndex((occurrence) => occurrence.root === before.root && occurrence.start >= before.start)
        : list.findIndex((occurrence) => {
          try {
            return occurrence.range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0;
          } catch {
            return false;
          }
        });
      if (index < 0) index = Math.min(previousIndex, list.length - 1);
    } else if (list.length) {
      index = 0;
    }
    current.current = index;
    paint();
  }, [paint, recount]);

  const close = useCallback(() => {
    window.clearTimeout(settle.current);
    setOpen(false);
    found.current = [];
    current.current = -1;
    setTally({ index: -1, count: 0, capped: false });
    clearFind(owner.current);
    const back = restoreFocus.current;
    restoreFocus.current = null;
    // 焦点还在查找条里才还回去；人已经点去别处了就不抢。
    if (back instanceof HTMLElement && back.isConnected && bar.current?.contains(document.activeElement)) back.focus({ preventScroll: true });
  }, []);

  // 进可关闭层那一摞：Esc 一次退一层，查找条开在抽屉、侧栏里时先关它、不连抽屉一起关。
  // 点会话别处不关 —— 一边看一边跳是查找的本分。
  useDismissable({ enabled: open, containerRef: bar, onClose: close, closeOnOutside: false });

  const show = useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      restoreFocus.current = active && active !== document.body ? active : null;
      reopened.current = true;
    }
    setOpen(true);
    setFocusRequest((value) => value + 1);
  }, []);

  // 已经开着再按 ⌘F：回到输入框、全选，跟浏览器一样直接打新的词。在画出来的同一拍里给焦点，
  // 不等下一帧：⌘F 之后紧跟着打的字不能落到别处去（落到会话里就成了 c、r 那些单键快捷键）。
  useLayoutEffect(() => {
    if (!focusRequest) return;
    input.current?.focus();
    input.current?.select();
    // 关掉时命中全清了，词却留在框里：重新打开就拿这个词当场再找一遍。不找的话框里写着词、
    // 计数却是 0/0，回车也跳不动；再照原样打一遍同一个词，值没变，onChange 也不来。
    if (reopened.current) {
      reopened.current = false;
      if (queryRef.current.trim()) searchFresh();
    }
  }, [focusRequest, searchFresh]);

  useEffect(() => registerConversationFinder({
    region: () => scrollRef.current?.parentElement ?? scrollRef.current,
    scope: () => conversationScope(scrollRef.current),
    owns: (node) => !!bar.current?.contains(node) || !!conversationScope(scrollRef.current)?.contains(node),
    isOpen: () => openRef.current,
    open: show,
    close,
    step,
  }), [close, scrollRef, show, step]);

  // 换会话就收起来；卸载时把标记一并收掉。
  useEffect(() => close, [close, resetKey]);

  // 开着就跟着会话的变化重数（只重数，不挪视口）。
  useEffect(() => {
    if (!open || !query.trim()) return;
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        searchKeep();
      }, RECOUNT_GAP_MS);
    };
    const observer = new MutationObserver(schedule);
    // 手动开合折叠块只改 open，不动子节点：也得重数，那一块里的命中才会跟着标出来 / 收掉。
    // toggle 不冒泡，在捕获阶段听。
    const watched = roots();
    for (const root of watched) {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      root.addEventListener("toggle", schedule, true);
    }
    return () => {
      observer.disconnect();
      for (const root of watched) root.removeEventListener("toggle", schedule, true);
      window.clearTimeout(timer);
    };
  }, [open, query, roots, searchKeep]);

  const onChange = (value: string) => {
    setQuery(value);
    queryRef.current = value;
    // 输入法还在拼（拼音字母）时不找，选定了字再找。
    if (!composing.current) searchFresh();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };

  if (!open) return null;
  const { index, count, capped } = tally;
  const slot = findSlotFor(scrollRef.current);
  const node = (
    <div ref={bar} className="conversation-find" role="search">
      <input
        ref={input}
        className="conversation-find__input"
        type="text"
        value={query}
        placeholder="在会话中查找"
        aria-label="在会话中查找"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onChange(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
      />
      <span className={`conversation-find__count${query.trim() && !count ? " is-empty" : ""}`} aria-live="polite">
        {query.trim() ? `${count ? index + 1 : 0}/${count}${capped ? "+" : ""}` : ""}
      </span>
      <button type="button" className="conversation-find__button" aria-label="上一处" disabled={!count} onClick={() => step(-1)}>
        <CaretUp size={14} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" className="conversation-find__button" aria-label="下一处" disabled={!count} onClick={() => step(1)}>
        <CaretDown size={14} weight="bold" aria-hidden="true" />
      </button>
      <button type="button" className="conversation-find__button" aria-label="关闭查找" onClick={close}>
        <X size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );
  return slot ? createPortal(node, slot) : node;
}

/** 给查找条留的空位（多半在标题行里），见 search/conversationFind.ts 的 FIND_SLOT。`className` 给宿主自己摆位置。 */
export function ConversationFindSlot({ className }: { className?: string }) {
  return <span className={`conversation-find-slot${className ? ` ${className}` : ""}`} {...FIND_SLOT} />;
}
