// 会话里的 ⌘F 查找（components/ConversationFind.tsx + search/conversationFind.ts）。
//
// 钉的是用户要的那件事（2026-11-27「会话内支持 cmd+f 的查找，就和在浏览器按这个快捷键一样」）：
//   · ⌘F（非 Mac 上 Ctrl+F）在会话里开出查找条，焦点进输入框；浏览器自己的查找不再出来；
//   · 打字就找：计数、每一处都标出来、当前那一处更重，从正在看的地方找起；
//   · 回车 / ⇧回车 / ⌘G / ⇧⌘G 一处处跳，首尾相接；跳过去的字真露在屏幕上，新回复不把人拽回底部；
//   · 折好的执行过程里的字也找得到，跳过去时把那一块打开；
//   · 会话还在长时计数跟着变，但视口不动；
//   · Esc 关掉、标记收掉、焦点还回去；
//   · 页面上有好几条会话时交给正在用的那一条，同一时间只开一条；
//   · 一条会话都不在屏幕上（卸下了、被整块盖住）就不拦，浏览器自己的查找照常出来；
//   · 归属认会话的组件树：在侧聊回复框里、点了侧聊画在别处（portal）的控件后按 ⌘F，查的都是侧聊；⌘G 跟 ⌘F 同样判归属，焦点在代码编辑器、
//     别的会话里时不抢（审查第 1 轮 #1、#2）；
//   · 手动开合折叠块，标记跟着变；相邻两段拼不出假命中；流式续字时当前那一处不跳回前面；
//   · 查找条平时不画；按了才停进标题行里留的空位、在右边那排图标的左边（用户 2026-11-27 指的位置），
//     侧聊的停在侧聊自己顶上那一行；只有焦点 / 最近一次点击在侧聊里时 ⌘F 才查侧聊。
// 跑法：npm -w web run test:conversation-find-dom
import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { WAIT_TIMEOUT_MS, afterFrames } from "./wait-until.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/scripts/fixtures/conversation-find.html`);
  await page.waitForFunction(() => !!window.fixture);

  const mod = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta" : "Control");
  const feed = page.getByTestId("feed");
  const header = page.getByTestId("main-header");
  const bar = header.locator(".conversation-find");
  const sideBar = page.getByTestId("side-pane").locator(".conversation-find");
  const input = bar.getByRole("textbox", { name: "在会话中查找" });
  const count = bar.locator(".conversation-find__count");
  // 记下最近一次 ⌘F 有没有被拦下（拦下 = 浏览器自己的查找不会出来）。查找挂在 window 的捕获阶段、
  // 拦下时还会停止传播，所以这里也挂在 window 捕获阶段（同一处、晚登记，排在它后面照样听得到）。
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "f") window.lastFindPrevented = event.defaultPrevented;
    }, true);
  });
  const pressFind = async () => {
    await page.evaluate(() => { window.lastFindPrevented = undefined; });
    await page.keyboard.press(`${mod}+f`);
    return page.evaluate(() => window.lastFindPrevented);
  };
  // 当前那一处标的是什么字、在不在会话视口和窗口里；别处标了几处。
  const marks = () => page.evaluate(() => {
    const current = CSS.highlights.get("conversation-find-current");
    const range = current ? [...current][0] : null;
    const view = document.querySelector('[data-testid="feed"]').getBoundingClientRect();
    const rect = range?.getBoundingClientRect();
    return {
      text: range?.toString() ?? null,
      item: range?.startContainer.parentElement.closest("[data-item]")?.dataset.item ?? null,
      others: CSS.highlights.get("conversation-find")?.size ?? 0,
      onScreen: !!rect && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1 && rect.bottom <= innerHeight,
    };
  });
  const atBottom = () => feed.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 2);

  // 首屏贴着底。
  await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="feed"]');
    return node && node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
  }, null, { timeout: WAIT_TIMEOUT_MS });

  // ── 0. 平时不画：标题行里那个空位是空的、不占地方 ──────────────────────────────
  assert.equal(await page.locator(".conversation-find").count(), 0, "没按 ⌘F 就没有查找条");
  assert.equal(await header.locator(".conversation-find-slot").evaluate((node) => getComputedStyle(node).display), "none", "空位平时不占地方");

  // ── 1. ⌘F 开出查找条，焦点在输入框里，浏览器的查找被拦下 ─────────────────────
  await feed.click({ position: { x: 20, y: 20 } });
  assert.equal(await pressFind(), true, "会话在屏幕上时 ⌘F 归会话查找");
  await input.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("conversation-find__input")), true, "焦点进了输入框");
  assert.equal(await sideBar.count(), 0, "只开焦点所在的那一条");
  // 停在标题行里：在这一行的高度之内、紧挨在右边那排图标的左边，不浮在会话上。
  const docked = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="main-header"] .conversation-find').getBoundingClientRect();
    const row = document.querySelector('[data-testid="main-header"]').getBoundingClientRect();
    const acts = document.querySelector('[data-testid="acts"]').getBoundingClientRect();
    const title = document.querySelector('[data-testid="main-header"] .task-detail-title').getBoundingClientRect();
    return { inRow: bar.top >= row.top && bar.bottom <= row.bottom, gap: acts.left - bar.right, afterTitle: bar.left > title.right };
  });
  assert.ok(docked.inRow, "查找条在标题行的高度之内");
  assert.ok(docked.afterTitle && docked.gap >= 0 && docked.gap <= 16, `紧挨在图标左边（隔 ${docked.gap}px）`);

  // ── 2. 打字就找：从正在看的地方（底部）找起 ───────────────────────────────
  await page.keyboard.type("编辑器");
  await count.filter({ hasText: "3/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  let marked = await marks();
  assert.equal(marked.text, "编辑器");
  assert.equal(marked.item, "last", "视口在底部，第一处落在底部那一条");
  assert.equal(marked.others, 2, "另外两处也标出来");

  // ── 3. 回车下一处（首尾相接）、⇧回车上一处、⌘G / ⇧⌘G 同样 ─────────────────────
  await page.keyboard.press("Enter");
  await count.filter({ hasText: "1/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  marked = await marks();
  assert.equal(marked.item, "requirement", "从最后一处往下跳回到第一处");
  assert.ok(marked.onScreen, "跳过去的字真的露在屏幕上");
  await page.keyboard.press("Enter");
  await count.filter({ hasText: "2/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal((await marks()).item, "middle");
  await page.keyboard.press("Shift+Enter");
  await count.filter({ hasText: "1/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press(`${mod}+g`);
  await count.filter({ hasText: "2/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press(`${mod}+Shift+g`);
  await count.filter({ hasText: "1/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.ok((await marks()).onScreen);

  // ── 4. 会话还在长：计数跟着变，视口不动、不被拽回底部 ─────────────────────────
  const held = await feed.evaluate((node) => node.scrollTop);
  await page.evaluate(() => window.fixture.append("新回复里又提了一次编辑器。"));
  await count.filter({ hasText: "1/4" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await afterFrames(page);
  assert.equal(await feed.evaluate((node) => node.scrollTop), held, "新回复不该把读者从查找处拽走");
  assert.equal(await atBottom(), false);
  assert.equal((await marks()).item, "requirement", "当前那一处不因为重数而换");

  // ── 5. 折好的执行过程里的字：找得到，跳过去时把那一块打开 ──────────────────────
  const fold = page.getByTestId("fold");
  assert.equal(await fold.evaluate((node) => node.open), false);
  await input.fill("旁路通道");
  await count.filter({ hasText: "1/1" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('[data-testid="fold"]')?.open, null, { timeout: WAIT_TIMEOUT_MS });
  await page.waitForFunction(() => [...(CSS.highlights.get("conversation-find-current") ?? [])][0]?.toString() === "旁路通道", null, { timeout: WAIT_TIMEOUT_MS });
  assert.ok((await marks()).onScreen, "打开后那几个字露在屏幕上");

  // 手动开合折叠块：命中跟着标出来（只改了 open、没动子节点也算）。
  await fold.evaluate((node) => { node.open = false; });
  await input.fill("残留进程");
  await count.filter({ hasText: "/2" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal((await marks()).item, "leftover", "打字时落在看得见的那一处，不去翻折叠块");
  assert.equal((await marks()).others, 0, "折叠块关着，里面那一处先不标");
  await fold.locator("summary").click();
  await page.waitForFunction(() => CSS.highlights.get("conversation-find")?.size === 1, null, { timeout: WAIT_TIMEOUT_MS });

  // 折叠块套在正文外面（duet 的议题整个装在 `<details>` 里）：手动打开它，里面的命中也跟着标出来。
  await input.fill("议题专用词");
  await count.filter({ hasText: "/2" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal((await marks()).others, 0, "议题关着，里面那一处先不标");
  await page.getByTestId("topic").locator("summary").click();
  await page.waitForFunction(() => CSS.highlights.get("conversation-find")?.size === 1, null, { timeout: WAIT_TIMEOUT_MS });
  await page.getByTestId("topic").evaluate((node) => { node.open = false; });

  // 相邻两段的字不连着：「甲乙」「丙丁」拼不出「乙丙」。
  await input.fill("甲乙");
  await count.filter({ hasText: "1/1" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await input.fill("乙丙");
  await count.filter({ hasText: "0/0" }).waitFor({ timeout: WAIT_TIMEOUT_MS });

  // 流式续字：同一个文本节点被整段改写，当前那一处（第二个「续写词」）不跳回这一段的第一处。
  await input.fill("续写词");
  await count.filter({ hasText: "/3" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  for (let tries = 0; tries < 3 && !(await count.textContent()).startsWith("2/"); tries += 1) {
    await input.press("Enter");
    await afterFrames(page);
  }
  assert.equal(await count.textContent(), "2/3");
  // 前面那条回复同时在长（全文偏移整体后移二十多个字），当前这条又被整段改写：照样认得回第二处。
  await page.evaluate(() => window.fixture.rewrite({
    leftover: "看了一眼残留进程，议题专用词也提了。后来又补了一大段说明，把整体的位置往后推了。",
    stream: "续写词甲，续写词乙，续写词丙。续写词丁。",
  }));
  await count.filter({ hasText: "/4" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal(await count.textContent(), "2/4", "续字之后当前那一处还是第二个");
  assert.equal(await page.evaluate(() => {
    const range = [...(CSS.highlights.get("conversation-find-current") ?? [])][0];
    return range ? range.startContainer.data.slice(0, range.startOffset).split("续写词").length - 1 : -1;
  }), 1, "标的是这一段里的第二处");

  // 找不到时计数写 0/0，跳转键不可点，也没有残留的标记。
  await input.fill("没有这个词");
  await count.filter({ hasText: "0/0" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal(await bar.getByRole("button", { name: "下一处" }).isDisabled(), true);
  assert.equal((await marks()).text, null);

  // ── 6. Esc 关掉：标记收掉；再开时留着上次的词、全选好；焦点还给打开前的地方 ───────────
  await input.fill("编辑器");
  await count.filter({ hasText: "/4" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => CSS.highlights.has("conversation-find") || CSS.highlights.has("conversation-find-current")), false, "关掉后标记收掉");

  await feed.click({ position: { x: 20, y: 20 } });
  await page.getByTestId("outside").focus();
  assert.equal(await pressFind(), true);
  await input.waitFor();
  // 留着上次的词，全选好直接打新的；而且一打开就拿这个词再找了一遍（用户 2026-11-27：Esc 关掉
  // 再 ⌘F，框里还是那个词，却什么都搜不到）。
  assert.equal(await input.inputValue(), "编辑器", "再开时留着上次的词");
  await count.filter({ hasText: "/4" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  assert.equal((await marks()).text, "编辑器", "重新打开就标出来，不用再打一遍");
  assert.ok(await page.evaluate(() => CSS.highlights.get("conversation-find")?.size === 3), "其余三处也标上");
  await page.waitForFunction(() => {
    const node = document.activeElement;
    return node instanceof HTMLInputElement && node.selectionStart === 0 && node.selectionEnd === node.value.length;
  }, null, { timeout: WAIT_TIMEOUT_MS });
  const reopenedAt = await count.textContent();
  await page.keyboard.press("Enter");
  await page.waitForFunction((before) => document.querySelector(".conversation-find__count")?.textContent !== before, reopenedAt, { timeout: WAIT_TIMEOUT_MS });
  assert.match(await count.textContent(), /^[1-4]\/4$/, "回车照常往下跳");
  await input.press(`${mod}+a`);
  await page.waitForFunction(() => {
    const node = document.activeElement;
    return node instanceof HTMLInputElement && node.selectionStart === 0 && node.selectionEnd === node.value.length;
  }, null, { timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid ?? null), "outside", "焦点还给打开前的输入框");

  // ── 7. 好几条会话：交给正在用的那一条，同一时间只开一条 ──────────────────────────
  await feed.click({ position: { x: 20, y: 20 } });
  await pressFind();
  await input.waitFor();
  await page.getByTestId("side").click({ position: { x: 20, y: 20 } });
  assert.equal(await pressFind(), true);
  await sideBar.waitFor();
  // 侧聊的查找条在侧聊自己顶上单独一行：不浮在消息上，也不跑去主会话的标题行（用户 2026-11-27）。
  const sidePlaced = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="side-pane"] .conversation-find').getBoundingClientRect();
    const body = document.querySelector('[data-testid="side"]').getBoundingClientRect();
    const pane = document.querySelector('[data-testid="side-pane"]').getBoundingClientRect();
    return { above: bar.bottom <= body.top + 1, wide: bar.width >= pane.width - 24, position: getComputedStyle(document.querySelector('[data-testid="side-pane"] .conversation-find')).position };
  });
  assert.equal(sidePlaced.position, "static", "侧聊的查找条不浮着");
  assert.ok(sidePlaced.above, "侧聊的查找条在侧聊消息上方");
  assert.ok(sidePlaced.wide, "铺满侧聊的宽度");
  assert.equal(await header.locator(".conversation-find").count(), 0, "主会话标题行里没有它");
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
  // 紧跟着 ⌘F 就打字，不等：字得落进刚开的查找条，而不是别处。
  await page.keyboard.type("编辑器");
  await sideBar.locator(".conversation-find__count").filter({ hasText: "1/1" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await sideBar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

  // 焦点在侧聊回复框里（不在侧聊正文里，是正文的兄弟）：查的是侧聊，不是主会话。
  await feed.click({ position: { x: 20, y: 20 } });
  await pressFind();
  await input.waitFor();
  await page.getByTestId("side-composer").click();
  assert.equal(await pressFind(), true);
  await sideBar.waitFor();
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await sideBar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

  // 侧聊自己的控件画在侧聊那一块外面（portal 进面板头、portal 进 body）：点它、或焦点落在它上面，
  // 再按 ⌘F 查的仍是侧聊（审查第 2 轮）。
  for (const [via, act] of [
    ["点面板头里侧聊的按钮", () => page.getByTestId("side-head-button").click()],
    ["焦点落在 body 里侧聊的列表项上", () => page.getByTestId("side-list-item").focus()],
  ]) {
    await feed.click({ position: { x: 20, y: 20 } });
    await act();
    assert.equal(await pressFind(), true, via);
    await sideBar.waitFor({ timeout: WAIT_TIMEOUT_MS });
    assert.equal(await bar.count(), 0, `${via}：查的是侧聊，不是主会话`);
    await page.keyboard.press("Escape");
    await sideBar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });
  }

  // ⌘G 跟 ⌘F 同样判归属：主会话开着查找时，焦点去了代码编辑器 / 侧聊回复框，这对键不归主会话。
  await page.evaluate(() => {
    window.editorKeys = 0;
    document.querySelector('[data-testid="editor"]').addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "g" && !event.defaultPrevented) window.editorKeys += 1;
    });
  });
  await feed.click({ position: { x: 20, y: 20 } });
  await pressFind();
  await input.fill("编辑器");
  await count.filter({ hasText: "/4" }).waitFor({ timeout: WAIT_TIMEOUT_MS });
  const parked = await count.textContent();
  await page.getByTestId("editor").click();
  await page.keyboard.press(`${mod}+g`);
  await afterFrames(page);
  assert.equal(await count.textContent(), parked, "焦点在代码编辑器里，⌘G 不挪会话");
  assert.equal(await page.evaluate(() => window.editorKeys), 1, "⌘G 原样送到编辑器手里");
  assert.equal(await pressFind(), false, "代码编辑器里的 ⌘F 也归它自己");
  await page.getByTestId("side-composer").click();
  await page.keyboard.press(`${mod}+g`);
  await afterFrames(page);
  assert.equal(await count.textContent(), parked, "焦点在侧聊里，⌘G 不挪主会话");
  // 回到主会话里，⌘G 照常往下跳。
  await feed.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press(`${mod}+g`);
  await page.waitForFunction((before) => document.querySelector('[data-testid="main-header"] .conversation-find__count')?.textContent !== before, parked, { timeout: WAIT_TIMEOUT_MS });
  await input.focus();
  await page.keyboard.press("Escape");
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

  // 焦点和点击都不在任何一条会话里：给占地方最大的那一条。
  await page.getByTestId("outside").click();
  assert.equal(await pressFind(), true);
  await input.waitFor();
  await page.keyboard.press("Escape");
  await bar.waitFor({ state: "detached", timeout: WAIT_TIMEOUT_MS });

  // ── 8. 会话被整块盖住 / 卸下了：不拦，浏览器自己的查找照常出来 ─────────────────────
  await page.evaluate(() => window.fixture.cover(true));
  await page.getByTestId("cover").waitFor();
  assert.equal(await pressFind(), false, "会话被盖住时 ⌘F 让给浏览器");
  assert.equal(await bar.count(), 0);
  await page.evaluate(() => window.fixture.cover(false));
  await page.evaluate(() => window.fixture.mount(false));
  await feed.waitFor({ state: "detached" });
  assert.equal(await pressFind(), false, "没有会话时 ⌘F 让给浏览器");

  assert.deepEqual(errors, []);
  console.log("conversation find DOM regression passed");
} finally {
  await browser?.close();
  await web.close();
}
