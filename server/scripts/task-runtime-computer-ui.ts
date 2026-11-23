import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";

type ChangeTarget = (windowTitle?: string, application?: string) => void;

export async function checkComputerPreviewLayout(page: Page, screenshots: string, changeTarget: ChangeTarget, nextTurn: () => void) {
  const computer = page.getByRole("complementary", { name: "电脑操作" });
  const liveImage = computer.getByRole("img", { name: "电脑操作实时画面" });
  const cases = [
    { name: "portrait", width: 240, height: 420, viewport: { width: 1600, height: 1000 } },
    { name: "large", width: 1920, height: 1080, viewport: { width: 1600, height: 1000 } },
    { name: "tall", width: 180, height: 1200, viewport: { width: 1600, height: 1000 } },
    { name: "mobile", width: 240, height: 420, viewport: { width: 320, height: 568 } },
    { name: "short", width: 1920, height: 1080, viewport: { width: 568, height: 240 } },
  ];
  for (const sample of cases) {
    const enteringNarrow = page.viewportSize()!.width > 720 && sample.viewport.width <= 720;
    await page.setViewportSize(sample.viewport);
    if (enteringNarrow) {
      await page.getByRole("button", { name: "收起 Inspector", exact: true }).click();
      await page.getByRole("complementary", { name: "Inspector 侧边栏" }).waitFor({ state: "hidden" });
    }
    await page.evaluate(({ width, height }) => { (window as any).previewSize = { width, height }; }, sample);
    await page.waitForFunction(({ width, height }) => {
      const image = document.querySelector<HTMLImageElement>(".runtime-computer-target img");
      const card = document.querySelector<HTMLElement>(".runtime-activity-preview");
      return image?.naturalWidth === width && image.naturalHeight === height
        && Math.abs(Number(card?.style.getPropertyValue("--preview-aspect-ratio")) - width / height) < 0.001;
    }, sample);
    const geometry = await computer.evaluate((card) => {
      const image = card.querySelector("img")!;
      const target = card.querySelector(".runtime-computer-target")!;
      const close = card.querySelector('[aria-label="关闭操作预览"]')!;
      return { card: card.getBoundingClientRect().toJSON(), image: image.getBoundingClientRect().toJSON(),
        target: target.getBoundingClientRect().toJSON(), close: close.getBoundingClientRect().toJSON(),
        parent: card.parentElement!.getBoundingClientRect().toJSON() };
    });
    const small = sample.viewport.width <= 720;
    assert.ok(geometry.card.width <= (small ? 200 : 304) + 1, `${sample.name}: width cap`);
    assert.ok(geometry.image.height <= (small ? 160 : 240) + 1, `${sample.name}: height cap`);
    assert.ok(Math.abs(geometry.image.width / geometry.image.height - sample.width / sample.height) < 0.01, `${sample.name}: aspect ratio`);
    assert.ok(Math.abs(geometry.card.width - geometry.image.width) <= 2, `${sample.name}: no horizontal padding`);
    assert.ok(Math.abs(geometry.card.height - geometry.image.height) <= 2, `${sample.name}: no vertical padding`);
    assert.ok(Math.abs(geometry.target.height - geometry.image.height) < 1, `${sample.name}: fitted target`);
    assert.ok(geometry.card.right <= Math.min(sample.viewport.width, geometry.parent.right) && geometry.card.left >= geometry.parent.left, `${sample.name}: horizontal bounds`);
    assert.ok(geometry.card.bottom <= Math.min(sample.viewport.height, geometry.parent.bottom), `${sample.name}: vertical bounds`);
    assert.ok(geometry.close.left >= geometry.card.left && geometry.close.right <= geometry.card.right, `${sample.name}: close reachable`);
    await computer.getByRole("button", { name: "关闭操作预览" }).click({ trial: true });
    await computer.getByRole("button", { name: "收起操作预览" }).click({ trial: true });
    await page.screenshot({ path: join(screenshots, `computer-size-${sample.name}.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => { (window as any).previewSize = { width: 640, height: 400 }; });
  await liveImage.waitFor();
  await checkKeyboardAndRecovery(page, screenshots, changeTarget);
  const starts = await page.evaluate(() => (window as any).previewMessages.filter((message: any) => message.action === "start").length);
  await computer.getByRole("button", { name: "关闭操作预览" }).click();
  await computer.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => (window as any).previewMessages.at(-1).action), "stop");
  changeTarget();
  await page.waitForResponse((response) => response.url().endsWith("/api/tasks/runtime/runtime"));
  assert.equal(await computer.count(), 0);
  assert.equal(await page.evaluate(() => (window as any).previewMessages.filter((message: any) => message.action === "start").length), starts);
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.waitForResponse((response) => response.url().endsWith("/api/tasks/other/runtime"));
  await page.getByRole("button", { name: "切换任务", exact: true }).click();
  await page.waitForResponse((response) => response.url().endsWith("/api/tasks/runtime/runtime"));
  assert.equal(await computer.count(), 0);
  await page.reload();
  await page.waitForResponse((response) => response.url().endsWith("/api/tasks/runtime/runtime"));
  assert.equal(await computer.count(), 0);
  assert.equal(await page.evaluate(() => (window as any).previewMessages.length), 0);
  nextTurn();
  await liveImage.waitFor();
  await computer.getByRole("button", { name: "收起操作预览" }).click();
  await computer.getByRole("button", { name: "关闭操作预览" }).click();
  await computer.waitFor({ state: "hidden" });
  nextTurn();
  await liveImage.waitFor();
  await computer.getByRole("button", { name: "关闭操作预览" }).focus();
  await page.keyboard.press("Escape");
  await computer.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => (window as any).previewMessages.at(-1).action), "stop");
  nextTurn();
  await liveImage.waitFor();
}

async function checkKeyboardAndRecovery(page: Page, screenshots: string, changeTarget: ChangeTarget) {
  const computer = page.getByRole("complementary", { name: "电脑操作" });
  const liveImage = computer.getByRole("img", { name: "电脑操作实时画面" });
  const reply = page.getByRole("textbox", { name: "回复任务", exact: true });
  await reply.focus();
  await page.keyboard.press("Escape");
  assert.equal(await reply.getAttribute("data-escapes"), "1");
  assert.equal(await computer.count(), 1);
  const openDialog = page.getByRole("button", { name: "确认操作", exact: true });
  const dialog = page.getByRole("dialog", { name: "确认操作" });
  await openDialog.click();
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await computer.count(), 1);

  await endCurrentPreview(page);
  await openDialog.click();
  await dialog.waitFor();
  changeTarget("回车验证窗口");
  await liveImage.waitFor();
  await page.screenshot({ path: join(screenshots, "computer-review-modal-enter.png") });
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await openDialog.getAttribute("data-confirmations"), "1");
  assert.equal(await computer.count(), 1);

  await endCurrentPreview(page);
  await openDialog.click();
  await dialog.waitFor();
  changeTarget("Esc验证窗口", "com.apple.Calculator");
  await liveImage.waitFor();
  await page.screenshot({ path: join(screenshots, "computer-review-modal-escape.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await openDialog.getAttribute("data-confirmations"), "1");
  assert.equal(await computer.count(), 1);
  const previousSource = await liveImage.getAttribute("src");
  await page.waitForFunction((source) => document.querySelector(".runtime-computer-target img")?.getAttribute("src") !== source, previousSource);

  await endCurrentPreview(page);
  changeTarget("回车验证窗口");
  await liveImage.waitFor();
  await page.screenshot({ path: join(screenshots, "computer-review-recovered.png") });
  assert.equal(await computer.getByRole("button", { name: "关闭操作预览" }).count(), 1);
}

async function endCurrentPreview(page: Page) {
  await page.evaluate(() => {
    const request = (window as any).previewMessages.findLast((message: any) => message.action === "start");
    window.dispatchEvent(new CustomEvent("navi:computer-preview", { detail: { id: request.id, state: "ended" } }));
  });
  await page.getByRole("complementary", { name: "电脑操作" }).waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => (window as any).previewMessages.at(-1).action), "stop");
}
