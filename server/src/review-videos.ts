import { readEnv } from "@navi/shared/env-names";
import type { Hono } from "hono";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { DATA_DIR, REPO_DIR } from "./paths.js";

// ── 待审视频预览(Tailscale 旁路)─────────────────────────────────────────────
// 待审 mp4 软链到仓库根的 review/ 下,手机经 Tailscale 直接开
// http://<tailnet-ip>:4317/review/current/ 审核,不必另起第二个服务。必须注册在下方
// catch-all "/*" 之前,否则被 SPA 兜底截走。SPA 那条 readFile 把整文件读进内存、不支持
// Range;视频大且要拖动进度,所以这里单独用 createReadStream 流式 + 解析 Range 返回 206。
// createReadStream 跟随软链,所以 review 目录放软链即可,无需拷贝原片。
// 根目录默认跟随 navi 仓库(review/ 在仓库根下,迁机器也不失效);代码不在仓库里(独立 app,
// bundle 只读、放不进软链)时落到数据目录下。可用 NAVI_REVIEW_ROOT 覆盖。
const REVIEW_ROOT = normalize(readEnv(process.env, "NAVI_REVIEW_ROOT") ?? join(REPO_DIR ?? DATA_DIR, "review"));
export function mountReviewVideos(app: Hono): void {
  app.get("/review", (c) => c.redirect("/review/"));
  app.get("/review/*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/review\/?/, "");
    const target = normalize(join(REVIEW_ROOT, rel));
    // 防路径穿越:解析后必须仍落在 ROOT 内(软链的"目标"可以在 ROOT 外——那正是本方案的关键)。
    // 分隔符走 `sep`:`normalize` 在 Windows 上还的是反斜杠,拼 `/` 比前缀恒为假,整个
    // /review/ 会全线 404(不是拒绝越界,是连界内的也进不去)。
    if (target !== REVIEW_ROOT && !target.startsWith(REVIEW_ROOT + sep)) return c.notFound();
    if (!existsSync(target)) return c.notFound();
    const st = statSync(target); // 跟随软链

    // 目录 → 极简清单页,手机点开就能播。
    if (st.isDirectory()) {
      const base = "/review/" + (rel ? rel.replace(/\/+$/, "") + "/" : "");
      const items = readdirSync(target)
        .filter((n) => n.toLowerCase().endsWith(".mp4"))
        .sort()
        .map((n) => {
          const href = base + encodeURIComponent(n);
          return `<li><a href="${href}">${n}</a><video controls preload="metadata" src="${href}"></video></li>`;
        })
        .join("\n");
      return c.html(
        `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
          `<title>待审视频</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:1rem;background:#111;color:#eee}` +
          `h2{font-size:1.1rem}ul{padding:0}li{list-style:none;margin:0 0 2rem}a{color:#6cf;word-break:break-all}` +
          `video{display:block;width:100%;max-width:760px;margin:.5rem 0;border-radius:8px;background:#000}</style>` +
          `<h2>待审视频 ${rel || "/"}</h2><ul>${items || "<li>(暂无 mp4)</li>"}</ul>`,
      );
    }

    // 文件:只放行 mp4,支持 Range 拖动。
    if (extname(target).toLowerCase() !== ".mp4") return c.notFound();
    const size = st.size;
    const range = c.req.header("range");
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(createReadStream(target, { start, end })) as any, {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(Readable.toWeb(createReadStream(target)) as any, {
      status: 200,
      headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": String(size) },
    });
  });
}
