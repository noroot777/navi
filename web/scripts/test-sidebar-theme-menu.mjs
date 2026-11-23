import assert from "node:assert/strict";
import { runServerFixture } from "./run-server-fixture.mjs";
import { animationsSettled } from "./wait-until.mjs";

await runServerFixture("assistant-browser-fixture", async (page, fixtureUrl) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  let projectKind = "non-git";
  await page.route("**/api/projects", async route => {
    const response = await route.fetch();
    const projects = await response.json();
    await route.fulfill({ response, json: projectKind === "empty" ? [] : projects.map(project => ({
      ...project,
      health: { ...project.health, isRepo: projectKind === "git", branch: projectKind === "git" ? "main" : null },
    })) });
  });

  const footer = page.locator(".workspace-sidebar-bottom");
  const themeKey = footer.getByRole("button", { name: /^配色：/u });
  const themeMenu = page.getByRole("menu", { name: "配色", exact: true });
  const checkMenu = async context => {
    await themeKey.click();
    await themeMenu.waitFor();
    await animationsSettled(page);
    const [footerBox, menuBox, keyBox, collapseBox] = await Promise.all([
      footer.boundingBox(), themeMenu.boundingBox(), themeKey.boundingBox(),
      footer.getByRole("button", { name: "收起侧边栏", exact: true }).boundingBox(),
    ]);
    assert.ok(footerBox && menuBox && keyBox && collapseBox, `${context}: footer controls are visible`);
    assert.ok(Math.abs(collapseBox.x + collapseBox.width - footerBox.x - footerBox.width) < 1,
      `${context}: footer actions stay right-aligned`);
    assert.ok(menuBox.x >= footerBox.x && menuBox.x + menuBox.width <= footerBox.x + footerBox.width + 1,
      `${context}: theme menu stays inside sidebar: ${JSON.stringify({ footerBox, menuBox })}`);
    assert.ok(menuBox.y >= 0 && menuBox.y + menuBox.height <= keyBox.y,
      `${context}: theme menu opens above its trigger within the viewport`);
    assert.deepEqual(await themeMenu.getByRole("menuitemradio").allInnerTexts(), ["跟随系统", "浅色", "深色"]);
    assert.equal(await themeMenu.getByRole("menuitemradio", { checked: true }).count(), 1);
    await page.keyboard.press("Escape");
    await themeMenu.waitFor({ state: "detached" });
    assert.equal(await themeKey.evaluate(node => document.activeElement === node), true);
  };

  for (const kind of ["non-git", "git", "empty"]) {
    projectKind = kind;
    await page.goto(fixtureUrl);
    if (kind === "empty") await page.getByRole("heading", { name: "还没有可用项目" }).waitFor();
    else await page.locator(".task-composer-panel.is-home").waitFor();
    assert.equal(await footer.locator(".workspace-git-context").count(), kind === "git" ? 1 : 0);
    for (const width of [220, 260, 320, 560]) {
      const separator = page.getByRole("separator", { name: "调整任务树宽度" });
      await separator.press("Home");
      for (let current = 220; current < width; current += 10) await separator.press("ArrowRight");
      await animationsSettled(page);
      assert.equal(Number(await separator.getAttribute("aria-valuenow")), width);
      await checkMenu(`${kind}, ${width}px`);
    }
    if (kind !== "empty") {
      await page.keyboard.press("f");
      await page.locator(".workspace-sidebar.is-spread-open").waitFor();
      await animationsSettled(page);
      await checkMenu(`${kind}, expanded`);
      await page.keyboard.press("Escape");
      await page.locator(".workspace-sidebar.is-spread").waitFor({ state: "detached" });
    }
  }

  projectKind = "non-git";
  await page.goto(fixtureUrl);
  await page.locator(".task-composer-panel.is-home").waitFor();
  for (const [label, value] of [["深色", "dark"], ["浅色", "light"], ["跟随系统", "system"]]) {
    await themeKey.click();
    const saved = page.waitForResponse(response => response.url().endsWith("/api/settings")
      && response.request().method() === "PATCH" && response.ok());
    await themeMenu.getByRole("menuitemradio", { name: label, exact: true }).click();
    await saved;
    await themeMenu.waitFor({ state: "detached" });
    await page.waitForFunction(expected => localStorage.getItem("navi.colorTheme") === expected, value);
    if (value !== "system") assert.equal(await page.locator("html").getAttribute("data-theme"), value);
    assert.equal(await themeKey.evaluate(node => document.activeElement === node), true);
  }
  await themeKey.click();
  await page.locator(".workspace-main").click();
  await themeMenu.waitFor({ state: "detached" });
});
