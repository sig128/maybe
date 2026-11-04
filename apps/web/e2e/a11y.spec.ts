import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openFlagshipDraft, ready, ROUTES } from "./helpers.ts";

/** axe-core with WCAG 2.0/2.1/2.2 A + AA rules on every main screen; serious and critical findings fail. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const summary: Record<string, { violations: Array<{ id: string; impact: string | null | undefined; nodes: number }>; passes: number }> = {};

test.afterAll(() => {
  mkdirSync("e2e/.output", { recursive: true });
  writeFileSync(`e2e/.output/axe-${test.info().project.name}.json`, JSON.stringify(summary, null, 2));
});

async function scan(page: import("@playwright/test").Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  summary[name] = { violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), passes: r.passes.length };
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), name).toEqual([]);
}

for (const path of ROUTES) {
  test(`axe ${path} @responsive`, async ({ page }) => {
    await ready(page, path);
    await scan(page, path);
  });
}

test("axe market drawer", async ({ page }) => {
  await ready(page, "/discover?market=orbit-launch");
  await expect(page.getByRole("dialog")).toBeVisible();
  await scan(page, "market drawer");
});

test("axe builder (sentence, graph alternative, list) and review", async ({ page }) => {
  await openFlagshipDraft(page);
  await scan(page, "builder · sentence");
  await page.getByRole("tab", { name: "List" }).click();
  await scan(page, "builder · list");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForURL(/\/review/);
  await scan(page, "review");
});
