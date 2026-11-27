import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

// 「信息」格「上下文」那一行的分项（task-detail/info/ContextBreakdownRows.tsx）：
// - 有分项：细条按分项分色（只画占着的几项，占 0 的不画），默认收起，标签旁的小箭头指到这一行才出；
// - 点细条那颗键就地展开，下面几行顺势下移；每项一行色块 · 名称 · token · 占比，认不出的类别原样显示；
// - 「MCP 工具」再点开按服务器列；最后一行淡字写几分钟前；
// - 展开状态记住，刷新后照旧；收着时列表里的键够不着（inert）；
// - 没有分项（codex）：细条单色、不可展开、没有箭头。
// 跑:npm -w web run test:context-breakdown-dom
const web = await startWebServer();
let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/context-breakdown.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const claude = page.getByTestId("claude");
  const codex = page.getByTestId("codex");
  const toggle = claude.getByRole("button", { name: /上下文分项/ });
  await toggle.waitFor();

  // 收起：分段细条，颜色键跟列表一一对应；占 0 的那一项不画。
  const segments = await claude.locator(".insp-bar__used > i").evaluateAll((items) => items.map((item) => item.dataset.ctx));
  assert.deepEqual(segments, ["system-prompt", "system-tools", "mcp-tools", "memory", "skills", "messages"]);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "默认收起");
  const fold = claude.locator(".insp-ctx__fold");
  assert.equal(await fold.evaluate((element) => element.getBoundingClientRect().height), 0, "收着不占地方");
  assert.equal(await claude.locator(".insp-ctx__inner").evaluate((element) => element.inert), true, "收着时里面的键够不着");
  const chev = claude.locator(".insp-ctx-label__chev");
  assert.equal(await chev.evaluate((element) => getComputedStyle(element).opacity), "0", "箭头平时不出");
  await toggle.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="claude"] .insp-ctx-label__chev')).opacity === "1");

  // 展开：就地插在下面，下面那几行顺势下移。
  const dirTop = async () => claude.locator("dt", { hasText: "目录" }).evaluate((element) => element.getBoundingClientRect().top);
  const before = await dirTop();
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.waitForTimeout(450);
  assert.ok((await dirTop()) > before + 150, "下面几行顺势下移");
  const rows = await claude.locator(".insp-ctx__list > li").evaluateAll((items) => items.map((item) => item.innerText.replace(/\s+/g, " ").trim()));
  assert.deepEqual(rows, [
    "系统提示 6,231 3.1%",
    "系统工具 19.6k 9.8%",
    "MCP 工具 53.5k 26.8%",
    "记忆文件 153 <0.1%",
    "技能 1,986 1.0%",
    "消息 565 0.3%",
    "Something new 0 0%",
    "压缩预留 33.0k 16.5%",
    "空闲 85.0k 42.5%",
  ]);
  // 两列数字右对齐：各行 token 那一列的右边缘是同一条线。
  const rights = await claude.locator(".insp-ctx__list .insp-ctx__row > :nth-child(3)")
    .evaluateAll((items) => [...new Set(items.map((item) => Math.round(item.getBoundingClientRect().right)))]);
  assert.equal(rights.length, 1, `token 一列右对齐（${rights}）`);
  assert.match(await claude.locator(".insp-ctx__stamp").innerText(), /^3 分钟前 · 回合结束时刷新$/);

  // MCP 工具再点开：按服务器列。
  const mcp = claude.getByRole("button", { name: /MCP 工具/ });
  assert.equal(await mcp.getAttribute("aria-expanded"), "false");
  await mcp.click();
  const servers = await claude.locator(".insp-ctx__sub > li").evaluateAll((items) => items.map((item) => item.innerText.replace(/\s+/g, " ").trim()));
  assert.deepEqual(servers, ["navi 48.6k 24.3%", "kb 4,916 2.5%"]);

  // 刷新后照旧展开；键盘收起。
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "展开状态记住");
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "键盘也能收起");
  await page.waitForTimeout(450);
  assert.equal(await fold.evaluate((element) => element.getBoundingClientRect().height), 0);

  // codex：没有分项 —— 单色细条、不可展开、没有箭头。
  assert.equal(await codex.getByRole("button", { name: /上下文分项/ }).count(), 0);
  assert.equal(await codex.locator(".insp-bar__used").count(), 0);
  assert.equal(await codex.locator(".insp-bar > i").count(), 1, "单色细条照旧");
  assert.equal(await codex.locator(".insp-ctx-label__chev, .insp-ctx").count(), 0);

  assert.deepEqual(errors, []);
  console.log("context breakdown: split bar, inline expand, MCP servers, persisted state and codex fallback passed");
} finally {
  await browser?.close();
  await web.close();
}
