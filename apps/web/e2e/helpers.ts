import { expect, type Page } from "@playwright/test";

/** Snapshot of the simulation's persisted state (balances, activity) straight from storage. */
export async function simState(page: Page): Promise<{ vault: { balances: Record<string, { available: unknown; reserved: unknown }> }; activity: Array<{ kind: string; title: string }>; strategies: Record<string, { status: string; doc: { title: string; allocations: Array<{ amount: string }> } }> }> {
  await page.waitForTimeout(150); // persistence is batched to the next microtask
  return page.evaluate(() => {
    const raw = localStorage.getItem("maybe.sim.v2");
    if (!raw) throw new Error("no simulation state");
    return JSON.parse(raw, (_k, v) => (v && typeof v === "object" && "$b" in v ? String(v.$b) : v));
  });
}

export async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("#main")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

export async function openFlagshipDraft(page: Page) {
  await ready(page, "/futures?tab=drafts");
  await page.getByRole("link", { name: /Orbit, vote & cup/ }).first().click();
  await page.waitForURL(/\/edit/);
}

export const ROUTES = ["/", "/discover", "/futures", "/money", "/agents", "/rooms", "/activity", "/ops", "/settings"];
