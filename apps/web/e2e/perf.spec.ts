import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openFlagshipDraft, ready } from "./helpers.ts";

/**
 * Responsiveness under live updates: long tasks while sample quotes tick and the
 * keeper runs, and input latency (Event Timing) for real interactions.
 * Numbers depend on this machine; they're recorded, not compared to invented targets.
 */
const results: Record<string, unknown> = {};
test.afterAll(() => {
  mkdirSync("e2e/.output", { recursive: true });
  writeFileSync("e2e/.output/perf.json", JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2));
});

async function observe(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __events: Array<{ name: string; d: number }> };
    w.__long = [];
    w.__events = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__events.push({ name: e.name, d: e.duration }))).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });
}
const read = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __events: Array<{ name: string; d: number }> };
    const long = w.__long;
    return { longTasks: long.length, longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)), worstLongTaskMs: Math.round(Math.max(0, ...long)), worstEventMs: Math.round(Math.max(0, ...w.__events.map((e) => e.d))), events: w.__events.length };
  });

test("Discover with ticking quotes for 12 s", async ({ page }) => {
  await ready(page, "/discover");
  await observe(page);
  await page.waitForTimeout(12_000);
  await page.getByPlaceholder("Search markets").fill("orbit");
  await page.waitForTimeout(500);
  const r = await read(page);
  results.discoverTicking = r;
  expect(r.worstLongTaskMs).toBeLessThan(500);
});

test("builder graph view and edits", async ({ page }) => {
  await openFlagshipDraft(page);
  await observe(page);
  const t0 = Date.now();
  await page.getByRole("tab", { name: "Graph" }).click();
  await page.locator(".react-flow__node").first().waitFor();
  const graphMs = Date.now() - t0;
  await page.getByRole("tab", { name: "List" }).click();
  await page.getByRole("tab", { name: "Sentence" }).click();
  await page.waitForTimeout(1000);
  const r = await read(page);
  results.builder = { graphFirstNodeMs: graphMs, ...r };
  expect(graphMs).toBeLessThan(5000);
});

test("money screen stays responsive while the keeper ticks", async ({ page }) => {
  await ready(page, "/money");
  await observe(page);
  for (const tab of ["Deposit", "Withdraw", "Deposit"]) {
    const t = page.getByRole("tab", { name: new RegExp(tab, "i") });
    if (await t.count()) await t.first().click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(4000);
  const r = await read(page);
  results.money = r;
  expect(r.worstEventMs).toBeLessThan(500);
});
