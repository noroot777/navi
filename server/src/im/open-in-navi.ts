// 飞书桌面端点「在 Navi 中打开」落到的那一页（pc_url，见 app-link.ts）：`/open-in-navi?project=&task=&instance=&fallback=`。
//
// 飞书只肯打开 http 链接，所以按钮指着本机回环地址；请求到了这里，由服务替用户在这台 Mac 上拉起
// Navi.app 窗口、换到那个任务（`open navi://open?...`，desktop/macos/Sources/DeepLink.swift），网页上只留一句
// 「已经在 Navi 里打开了」和一条在这里看的链接。
//
// 只认本机直连（回环 socket + 回环 Host + 没有转发头）：这是「坐在这台电脑前的人点了一下」才有的请求。
// 任何网页也能让浏览器请求它（同 navi:// 任何网页都能发起），所以它只做导航：id 只收字形、指纹对不上
// （别的 Mac 发的卡、这台上另一份 Navi）就说清楚、给原来那条地址，不打开一个同号的任务。
import { spawn } from "node:child_process";
import type { Context, Hono } from "hono";
import { isLocalDirect } from "../auth/remote-access.js";
import { instanceTag } from "../instance-tag.js";
import { DESKTOP_APP } from "../local-only.js";
import { OPEN_IN_NAVI_PATH, taskIdsOf } from "./app-link.js";

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(c: Context, title: string, lines: string[], status: 200 | 400 | 403 | 409 = 200) {
  const body = lines.map((line) => `<p>${line}</p>`).join("");
  return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title>`
    + `<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#222}`
    + `h1{font-size:18px;font-weight:600}a{color:#222}</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`, status);
}

/** 交给系统的 `open`：拉起 Navi.app 并让它导航。只做本机这一跳，参数都是校验过字形的 id。 */
export type AppOpener = (url: string) => Promise<boolean>;
export const openWithSystem: AppOpener = (url) => new Promise((resolve) => {
  const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
  child.once("error", () => resolve(false));
  child.once("exit", (code) => resolve(code === 0));
});

export function mountOpenInNavi(app: Hono, opener: AppOpener = openWithSystem, desktop = DESKTOP_APP): void {
  app.get(OPEN_IN_NAVI_PATH, async (c) => {
    if (!isLocalDirect(c)) return page(c, "打不开", ["这条链接只在发卡片的那台电脑上能用。"], 403);
    const params = new URL(c.req.url).searchParams;
    const ids = taskIdsOf(params);
    if (!ids) return page(c, "打不开", ["这不是一条任务链接。"], 400);
    const route = `/?${new URLSearchParams({ project: ids.project, ...(ids.task ? { task: ids.task } : {}) })}`;
    const tag = instanceTag();
    if (params.get("instance") !== tag) {
      const fallback = params.get("fallback");
      const usable = fallback && /^https?:\/\//i.test(fallback) ? fallback : null;
      return page(c, "这张卡片不是这台 Navi 发的", [
        "发卡片的是另一台电脑（或这台电脑上的另一份 Navi），这里没有那个任务。",
        ...(usable ? [`原来的地址：<a href="${escape(usable)}">${escape(usable)}</a>（要在那台电脑放开了其他设备访问才打得开）`] : []),
      ], 409);
    }
    if (!desktop) return c.redirect(route);
    const deep = `navi://open?${new URLSearchParams({ project: ids.project, ...(ids.task ? { task: ids.task } : {}), instance: tag })}`;
    if (!(await opener(deep))) return c.redirect(route);
    return page(c, "已在 Navi 里打开", [
      "Navi 窗口已经换到这个任务了，这一页可以关掉。",
      `窗口没出来？<a href="${escape(route)}">就在这里看</a>。`,
    ]);
  });
}
