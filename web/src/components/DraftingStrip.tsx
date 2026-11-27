// 正在生成的那一步（shared events.ts 的 drafting）：气泡尾上一行「正在写 方案.md · 已写 8,240 字」，
// 跟进行条同一副长相（字上扫光、后面跟着这一步写了多久）。生成完由那条工具行接替，这一行随之消失。
import type { DraftingEvent } from "@navi/shared";
import { draftingLabel } from "../lib/executionWords.ts";
import { LiveStrip } from "./LiveStrip.tsx";

export function DraftingStrip({ drafting }: { drafting: DraftingEvent }) {
  return <LiveStrip inline since={drafting.since} text={draftingLabel(drafting)} />;
}
