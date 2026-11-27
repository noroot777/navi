import "../styles/conversation-find.css";

/**
 * 会话里的 ⌘F（Windows/Linux 上 Ctrl+F）：像浏览器的「查找」一样在会话里找字、标出每一处、一处处跳。
 *
 * 为什么不交给浏览器自己的查找：Mac 版是 WKWebView，那里根本没有查找条，按了没反应；
 * 浏览器里也只找得到屏幕上画着的字，折起来的执行过程里的就找不到。
 *
 * 这里只管**认键、认会话**：页面上同时可能挂着好几条会话（主会话、侧聊、群聊），每条会话的
 * 查找条（components/ConversationFind.tsx）挂上时在这里登记，按下 ⌘F 时交给「此刻真在看的那一条」。
 * 一条都不在屏幕上（设置页、新建面板）就原样放过，浏览器自己的查找照常出来。
 */
export type ConversationFinder = {
  /** 会话那一块，用来判断它在不在屏幕上、焦点在不在它里面。 */
  region: () => HTMLElement | null;
  /** 查找条自己（停靠在标题行里时不在 region 里面）：焦点在它上面再按 ⌘F 也算这一条。 */
  owns: (node: Node) => boolean;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  step: (direction: 1 | -1) => void;
};

/**
 * 查找条停在哪：会话所在的那一块（`FIND_SCOPE`，一个任务详情、一个抽屉、一个群聊）在自己的标题行里
 * 留一个空位（`FIND_SLOT`），查找条就画进那里；只认离会话最近的那一块，那一块没留空位（侧聊那样
 * 窄的面板）就浮在会话右上角。空位平时是空的、不占地方，按了 ⌘F 才有东西。
 */
export const FIND_SCOPE = { "data-conversation-find-scope": "" } as const;
export const FIND_SLOT = { "data-conversation-find-slot": "" } as const;

export function findSlotFor(element: Element | null): HTMLElement | null {
  const scope = element?.closest("[data-conversation-find-scope]");
  if (!scope) return null;
  for (const slot of scope.querySelectorAll<HTMLElement>("[data-conversation-find-slot]")) {
    if (slot.closest("[data-conversation-find-scope]") === scope) return slot;
  }
  return null;
}

const finders = new Set<ConversationFinder>();
let lastPointer: EventTarget | null = null;

const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** 自带查找的编辑面（终端、代码编辑器）：⌘F 归它们自己。 */
const OWN_FIND = ".xterm, .cm-editor, .monaco-editor";

/**
 * 真露在屏幕上：不只是没有 display:none —— 铺开的侧栏、放大的预览会整块盖在会话上面，
 * 几何还在、人却看不见。在这一块里取上中下三个点问「最上面的是谁」，有一个点落在它自己身上就算。
 */
function onScreen(region: HTMLElement): boolean {
  if (typeof region.checkVisibility === "function" ? !region.checkVisibility() : !region.getClientRects().length) return false;
  const rect = region.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const x = rect.left + rect.width / 2;
  return [0.25, 0.5, 0.75].some((at) => {
    const hit = document.elementFromPoint(x, rect.top + rect.height * at);
    return !!hit && region.contains(hit);
  });
}

function pick(target: EventTarget | null): ConversationFinder | null {
  // 模态框盖着时只认框里的会话；框里没有就让给浏览器。
  const modal = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const candidates = [...finders].flatMap((finder) => {
    const region = finder.region();
    if (!region || (modal && !modal.contains(region)) || !onScreen(region)) return [];
    return [{ finder, region }];
  });
  if (!candidates.length) return null;
  for (const anchor of [target, document.activeElement, lastPointer]) {
    if (!(anchor instanceof Node)) continue;
    const owner = candidates.find(({ finder, region }) => region.contains(anchor) || finder.owns(anchor));
    if (owner) return owner.finder;
  }
  // 焦点和最近一次点击都不在任何一条会话里：给占地方最大的那一条（主会话，而不是旁边的侧聊）。
  const area = (region: HTMLElement) => {
    const rect = region.getBoundingClientRect();
    return rect.width * rect.height;
  };
  return candidates.reduce((best, next) => area(next.region) > area(best.region) ? next : best).finder;
}

function onKeyDown(event: KeyboardEvent) {
  const modifier = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (key === "f" && !event.shiftKey) {
    if (event.target instanceof Element && event.target.closest(OWN_FIND)) return;
    const finder = pick(event.target);
    if (!finder) return;
    event.preventDefault();
    event.stopPropagation();
    // 同一时间只开一条，跟浏览器只有一个查找条一样：标记也只有一份。
    finders.forEach((other) => { if (other !== finder && other.isOpen()) other.close(); });
    finder.open();
    return;
  }
  // ⌘G / ⇧⌘G：下一处 / 上一处，查找条开着才认（关着时这对键在浏览器里也是查找的续集）。
  if (key === "g") {
    const finder = [...finders].find((candidate) => candidate.isOpen());
    if (!finder) return;
    event.preventDefault();
    event.stopPropagation();
    finder.step(event.shiftKey ? -1 : 1);
  }
}

const onPointerDown = (event: PointerEvent) => { lastPointer = event.target; };

export function registerConversationFinder(finder: ConversationFinder): () => void {
  if (!finders.size) {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
  }
  finders.add(finder);
  return () => {
    finders.delete(finder);
    if (finders.size) return;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    lastPointer = null;
  };
}

const ALL = "conversation-find";
const CURRENT = "conversation-find-current";
/** 标出来的上限：再多也看不过来，Highlight 里塞几万个 Range 只会拖慢每一帧。 */
const MAX_PAINTED = 2_000;
let painter: object | null = null;

const highlightable = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * 标出每一处、当前那一处颜色更重。走 CSS Custom Highlight API：不往 React 管着的 DOM 里插 `<mark>`，
 * 会话一边在长、一边标着也不会跟渲染打架。不认这套 API 的浏览器不标，只照样一处处跳过去。
 */
export function paintFind(owner: object, all: readonly Range[], current: Range | null) {
  if (!highlightable()) return;
  painter = owner;
  CSS.highlights.set(ALL, new Highlight(...all.filter((range) => range !== current).slice(0, MAX_PAINTED)));
  if (current) CSS.highlights.set(CURRENT, new Highlight(current));
  else CSS.highlights.delete(CURRENT);
}

export function clearFind(owner: object) {
  if (painter !== owner || !highlightable()) return;
  painter = null;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}
