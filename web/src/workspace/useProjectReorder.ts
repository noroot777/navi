import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

// 项目切换下拉里拖动调先后。行本身就是拖柄：按住挪过几像素才算拖，没挪就是一次普通的点选。
// 拖动中其余行实时让位，松手才写一次整份顺序（onCommit）；Esc 或开始搜索就作废。
// 键盘走 ⌥↑ / ⌥↓，一下挪一格、当场写下。
//
// 没用原生 HTML5 拖放：它拖的是一张半透明快照、松手前列表不让位，在一个会滚动的小菜单里
// 很难看准落点；用指针事件自己算，落点就是眼前这一格。触摸屏上按住拖会跟滚动抢手势，所以只认鼠标/触控板。
const DRAG_THRESHOLD = 4;
const EDGE = 28;
const EDGE_STEP = 8;

type Pending = { id: string; pointerId: number; startY: number };

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
  const pending = useRef<Pending | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const pointerY = useRef(0);
  // 拖完松手时指针底下那一行会收到一次 click，不能把它当成「切到这个项目」。
  const swallowClick = useRef(false);

  const stop = useCallback(() => {
    pending.current = null;
    draftRef.current = null;
    setDraft(null);
    setDragging(null);
  }, []);

  useEffect(() => { if (!enabled) stop(); }, [enabled, stop]);

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
      const start = pending.current;
      if (!start || event.pointerId !== start.pointerId) return;
      pointerY.current = event.clientY;
      if (!draftRef.current) {
        if (Math.abs(event.clientY - start.startY) < DRAG_THRESHOLD) return;
        draftRef.current = ids;
        setDraft(ids);
        setDragging(start.id);
      }
      event.preventDefault();
      placeAt(start.id, event.clientY);
    };
    const up = (event: globalThis.PointerEvent) => {
      const start = pending.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const finished = draftRef.current;
      stop();
      if (!finished) return;
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 0);
      if (finished.some((value, i) => value !== ids[i])) onCommit(finished);
    };
    const cancel = (event: globalThis.PointerEvent) => {
      if (pending.current?.pointerId === event.pointerId) stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [ids, onCommit, placeAt, stop]);

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
      stop();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [dragging, stop]);

  const rowProps = (id: string) => ({
    "data-project-id": id,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || event.pointerType === "touch") return;
      pending.current = { id, pointerId: event.pointerId, startY: event.clientY };
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
    shouldSwallowClick: () => swallowClick.current,
  };
}
