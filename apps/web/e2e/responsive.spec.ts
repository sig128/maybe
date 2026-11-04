import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openFlagshipDraft, ready, ROUTES } from "./helpers.ts";

const shotDir = (project: string) => {
  const d = `e2e/.output/shots/${project}`;
  mkdirSync(d, { recursive: true });
  return d;
};

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `page is ${r.sw}px wide in a ${r.w}px viewport`).toBeLessThanOrEqual(r.w + 1);
}

for (const path of ROUTES) {
  test(`layout ${path} @responsive`, async ({ page }, info) => {
    await ready(page, path);
    await noHorizontalScroll(page);
    await page.screenshot({ path: `${shotDir(info.project.name)}/${path === "/" ? "overview" : path.slice(1)}.png` });
  });
}

test("builder and review @responsive", async ({ page }, info) => {
  await openFlagshipDraft(page);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `${shotDir(info.project.name)}/builder-sentence.png` });
  await page.getByRole("tab", { name: "Graph" }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shotDir(info.project.name)}/builder-graph.png` });
  await page.getByRole("tab", { name: "List" }).click();
  await page.screenshot({ path: `${shotDir(info.project.name)}/builder-list.png` });
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForURL(/\/review/);
  await noHorizontalScroll(page);
  await page.screenshot({ path: `${shotDir(info.project.name)}/review.png`, fullPage: true });
});

test("200% zoom (720×450 CSS px) keeps every screen usable", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const path of ROUTES) {
    await ready(page, path);
    await noHorizontalScroll(page);
    // primary navigation stays reachable
    await expect(page.getByRole("navigation").first()).toBeVisible();
  }
  await page.screenshot({ path: `${shotDir("zoom200")}/money.png` });
  await ctx.close();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("motion tokens collapse to zero", async ({ page }) => {
    await ready(page, "/");
    const d = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--m-base").trim());
    expect(["0ms", "0s", "0"]).toContain(d);
  });
});
