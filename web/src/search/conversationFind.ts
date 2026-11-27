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
  /** 会话正文那一块：只用来判断它此刻在不在屏幕上。 */
  region: () => HTMLElement | null;
  /** 会话所在的那一块（`FIND_SCOPE` 标的元素），归属认它，见下面的 `claimed`。 */
  scope: () => Element | null;
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
/**
 * 「正在用哪条会话」认的是最近一次点击 / 聚焦落在**哪个会话的组件树**里，不是落在哪块 DOM 里。
 *
 * 会话自己的控件不一定画在它那块 DOM 里：侧聊的「换一场 / 新开一场」portal 进了面板头，换一场的
 * 列表、悬停卡、选区动作条、各种选择器 portal 进了 body。按 DOM 包含关系认，点了这些再按 ⌘F 就
 * 查到了别的会话（审查第 1、2 轮）。React 的合成事件沿组件树冒泡、穿过 portal 回到创建它的会话，
 * 所以在会话那一块上挂捕获阶段的 pointerdown / focus：外层先、里层后，最后写下的就是最里面那一条。
 * 窗口上的原生监听在它们之前先清空 —— 点到任何会话之外（设置、终端、编辑器），就谁也不归。
 */
let claimed: Element | null = null;
const claim = (event: { currentTarget: EventTarget }) => {
  if (event.currentTarget instanceof Element) claimed = event.currentTarget;
};
export const FIND_SCOPE = { "data-conversation-find-scope": "", onPointerDownCapture: claim, onFocusCapture: claim } as const;
export const FIND_SLOT = { "data-conversation-find-slot": "" } as const;

/** 会话所在的那一块；没标 `FIND_SCOPE` 的（夹具、零散面板）就是正文外面那一层。 */
export function conversationScope(scroll: Element | null): Element | null {
  return scroll?.closest("[data-conversation-find-scope]") ?? scroll?.parentElement ?? scroll ?? null;
}

export function findSlotFor(element: Element | null): HTMLElement | null {
  const scope = element?.closest("[data-conversation-find-scope]");
  if (!scope) return null;
  for (const slot of scope.querySelectorAll<HTMLElement>("[data-conversation-find-slot]")) {
    if (slot.closest("[data-conversation-find-scope]") === scope) return slot;
  }
  return null;
}

const finders = new Set<ConversationFinder>();

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

/**
 * 这一下查找键归哪条会话。⌘F 和 ⌘G 都走这里 —— 跳下一处也只能交给此刻看得见、正在用的那一条。
 * 焦点在自带查找的编辑面里（终端、代码编辑器）一律不认，键归它们自己。
 */
function pick(target: EventTarget | null): ConversationFinder | null {
  if (target instanceof Element && target.closest(OWN_FIND)) return null;
  // 模态框盖着时只认框里的会话；框里没有就让给浏览器。
  const modal = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  const candidates = [...finders].flatMap((finder) => {
    const region = finder.region();
    if (!region || (modal && !modal.contains(region)) || !onScreen(region)) return [];
    return [{ finder, region }];
  });
  if (!candidates.length) return null;
  const owner = claimed?.isConnected ? claimed : null;
  if (owner) {
    // 认领的那一块就是某条会话的：它此刻看不见（被盖住了）就让给浏览器，不拿别的会话顶上 ——
    // 人在用的是它，查到别处只会看错。
    const own = [...finders].find((finder) => finder.scope() === owner);
    if (own) return candidates.some(({ finder }) => finder === own) ? own : null;
    // 那一块里没挂会话（比如抽屉里的任务正开着审查）：退到 DOM 上套着它的那几条里最里面的一条。
    const mine = candidates
        .filter(({ finder }) => finder.scope()?.contains(owner))
        .reduce<ConversationFinder | null>((inner, { finder }) => {
          const outer = inner?.scope();
          const next = finder.scope();
          return !inner || (outer && next && outer !== next && outer.contains(next)) ? finder : inner;
        }, null);
    if (mine) return mine;
  }
  // 最近一次点击 / 聚焦不在任何一条会话里：给占地方最大的那一条（主会话，而不是旁边的侧聊）。
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
    const finder = pick(event.target);
    if (!finder) return;
    event.preventDefault();
    event.stopPropagation();
    // 同一时间只开一条，跟浏览器只有一个查找条一样：标记也只有一份。
    finders.forEach((other) => { if (other !== finder && other.isOpen()) other.close(); });
    finder.open();
    return;
  }
  // ⌘G / ⇧⌘G：下一处 / 上一处。归属照 ⌘F 一样判，判给的那一条开着查找条才认；
  // 不然就原样放过（编辑器、别的会话、弹窗里的这对键归它们自己）。
  if (key === "g") {
    const finder = pick(event.target);
    if (!finder?.isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    finder.step(event.shiftKey ? -1 : 1);
  }
}

// 窗口捕获阶段先于 React 的根监听：每次点击 / 聚焦先清空，落在哪条会话的组件树里再由它认领。
const release = () => { claimed = null; };

export function registerConversationFinder(finder: ConversationFinder): () => void {
  if (!finders.size) {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", release, true);
    window.addEventListener("focusin", release, true);
  }
  finders.add(finder);
  return () => {
    finders.delete(finder);
    if (finders.size) return;
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", release, true);
    window.removeEventListener("focusin", release, true);
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
