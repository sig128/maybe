import { expect, test, type Page } from "@playwright/test";
import { openFlagshipDraft, ready, simState } from "./helpers.ts";

async function focusIsVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const s = getComputedStyle(el);
    return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
  });
}

test("skip link, visible focus on every tab stop of the shell", async ({ page }) => {
  await ready(page, "/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  let checked = 0;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(await focusIsVisible(page), `tab stop ${i + 2} has no visible focus`).toBe(true);
    checked++;
  }
  expect(checked).toBe(14);
});

test("command palette and g-shortcuts navigate without moving funds", async ({ page }) => {
  await ready(page, "/");
  const before = await simState(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  await page.keyboard.type("money");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/money/);
  for (const k of ["o", "d", "f", "m", "a", "r", "y", "p", "e", "m"]) {
    await page.keyboard.press("g");
    await page.keyboard.press(k);
  }
  await page.waitForURL(/\/money/);
  const after = await simState(page);
  expect(JSON.stringify(after.vault.balances)).toBe(JSON.stringify(before.vault.balances));
  expect(after.activity.length).toBe(before.activity.length);
});

test("review can be completed with the keyboard alone; Escape cancels the signature", async ({ page }) => {
  await openFlagshipDraft(page);
  await page.getByRole("button", { name: "Review", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/review/);
  const boxes = page.locator(".check-row input");
  for (const b of await boxes.all()) {
    await b.focus();
    await page.keyboard.press("Space");
    await expect(b).toBeChecked();
  }
  await page.getByRole("button", { name: "Sign and reserve" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // focus moved into the dialog
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  const before = await simState(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const after = await simState(page);
  expect(JSON.stringify(after.vault.balances)).toBe(JSON.stringify(before.vault.balances));
});
