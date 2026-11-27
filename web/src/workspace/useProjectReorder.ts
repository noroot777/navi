import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

// 项目切换下拉里拖动调先后。行本身就是拖柄：按住挪过几像素才算拖，没挪就是一次普通的点选。
// 拖动中其余行实时让位，松手才写一次整份顺序（onCommit）；Esc、开始搜索、切走窗口、在窗口外松手都作废。
// 键盘走 ⌥↑ / ⌥↓，一下挪一格、当场写下。
//
// 没用原生 HTML5 拖放：它拖的是一张半透明快照、松手前列表不让位，在一个会滚动的小菜单里
// 很难看准落点；用指针事件自己算，落点就是眼前这一格。触摸屏上按住拖会跟滚动抢手势，所以只认鼠标/触控板。
const DRAG_THRESHOLD = 4;
const EDGE = 28;
const EDGE_STEP = 8;

// 一次按下到松手是一个手势。`dragged`：这次挪过阈值、已经算拖了。
// 终止分两种，别混用：
//  · 取消拖动（abort）—— Esc、开始搜索/菜单关掉、切走窗口。只撤掉排出来的顺序；键还按着，手势留到真正
//    松手，剩下的移动不再接着拖。
//  · 手势结束（finish）—— 松手、浏览器取消指针、回来时键已松开（窗口外松的手）。拖过的就吞掉随后那一下
//    click：它是拖动的收尾，不是点选。
type Gesture = { id: string; pointerId: number; startY: number; dragged: boolean };

export function useProjectReorder({
  ids,
  enabled,
  listRef,
  onCommit,
}: {
  ids: string[];
  enabled: boolean;
  listRef: RefObject<HTMLElement | null>;
  onCommit: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const pointerY = useRef(0);
  // 拖过的手势结束后，紧跟这次**物理松手**的那一下 click 不能当成「切到这个项目」。标记一直留到那次松手
  // 之后才放（见 up），下一次按下也会清掉它 —— 不按计时器算：手势可能先于松手就结束了（切回标签时浏览器
  // 补发一次「键已松开」的移动），松手和 click 要等人真的松开才来。
  const swallowClick = useRef(false);

  // 撤掉这一次拖动排出来的顺序。手势本身留着到松手（只有没拖过的才直接丢）。
  const abort = useCallback(() => {
    if (gesture.current && !gesture.current.dragged) gesture.current = null;
    draftRef.current = null;
    setDraft(null);
    setDragging(null);
  }, []);

  // 手势结束：拖过的（放下的也好、撤销的也好）吞掉随后那一下 click。
  const finish = useCallback(() => {
    const ended = gesture.current;
    gesture.current = null;
    abort();
    if (ended?.dragged) swallowClick.current = true;
  }, [abort]);

  useEffect(() => { if (!enabled) abort(); }, [enabled, abort]);

  // 指针落在哪一格：数一数除被拖那行以外、中线在指针上方的行有几行。
  const placeAt = useCallback((id: string, y: number) => {
    const list = listRef.current;
    const current = draftRef.current;
    if (!list || !current) return;
    let index = 0;
    for (const row of list.querySelectorAll<HTMLElement>("[data-project-id]")) {
      if (row.dataset.projectId === id) continue;
      const rect = row.getBoundingClientRect();
      if (rect.top + rect.height / 2 < y) index += 1;
    }
    const next = current.filter((value) => value !== id);
    next.splice(index, 0, id);
    if (next.every((value, i) => value === current[i])) return;
    draftRef.current = next;
    setDraft(next);
  }, [listRef]);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const start = gesture.current;
      if (!start || event.pointerId !== start.pointerId) return;
      // 在窗口外松的手，这一页可能收不到那次 pointerup：回来时键已经松开，这次手势就算结束、作废不提交。
      if (event.buttons === 0) {
        finish();
        return;
      }
      pointerY.current = event.clientY;
      if (!draftRef.current) {
        if (start.dragged || Math.abs(event.clientY - start.startY) < DRAG_THRESHOLD) return;
        start.dragged = true;
        draftRef.current = ids;
        setDraft(ids);
        setDragging(start.id);
      }
      event.preventDefault();
      placeAt(start.id, event.clientY);
    };
    const up = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) {
        const finished = draftRef.current;
        finish();
        if (finished && finished.some((value, i) => value !== ids[i])) onCommit(finished);
      }
      // 这次松手之后紧跟着的那一下 click 被吞掉之后，再放行后面的点选。
      if (swallowClick.current) window.setTimeout(() => { swallowClick.current = false; }, 0);
    };
    // 新的一次按下：上一次手势留下的吞点击标记跟它无关了。
    const down = () => { swallowClick.current = false; };
    const cancel = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) finish();
    };
    // 切走窗口（⌘Tab、切标签）：这次拖动作废，但键还按着 —— 手势留到真正松手，切回来再松手的那一下
    // click 照样吞掉（同 Esc）。
    const blur = () => abort();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
    };
  }, [finish, ids, onCommit, placeAt]);

  // 列表比菜单高时，拖到上下边缘就往那边滚，滚动中照样重新算落点。
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const list = listRef.current;
      if (list) {
        const rect = list.getBoundingClientRect();
        const y = pointerY.current;
        const delta = y < rect.top + EDGE ? -EDGE_STEP : y > rect.bottom - EDGE ? EDGE_STEP : 0;
        if (delta && list.scrollHeight > list.clientHeight) {
          list.scrollTop += delta;
          placeAt(dragging, y);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, listRef, placeAt]);

  useEffect(() => {
    if (!dragging) return;
    // 挂在 window 的捕获阶段、先于菜单自己的 Esc（document 捕获）：拖动中按 Esc 只撤销这一次拖动，菜单留着。
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      abort();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [dragging, abort]);

  const rowProps = (id: string) => ({
    "data-project-id": id,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || event.pointerType === "touch") return;
      gesture.current = { id, pointerId: event.pointerId, startY: event.clientY, dragged: false };
      pointerY.current = event.clientY;
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!enabled || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const from = ids.indexOf(id);
      const to = from + (event.key === "ArrowUp" ? -1 : 1);
      if (from < 0 || to < 0 || to >= ids.length) return;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, id);
      onCommit(next);
      // 行换了位置，DOM 节点被挪动时焦点可能掉；落定后按 id 找回来。
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(id)}"]`)?.focus();
      });
    },
  });

  return {
    order: draft ?? ids,
    dragging,
    rowProps,
    // 键盘触发的 click（回车 / 空格，detail 为 0）不是哪次松手的收尾，不吞。
    shouldSwallowClick: (event: { detail: number }) => event.detail !== 0 && swallowClick.current,
  };
}
