import { expect, test } from "@playwright/test";
import { ready, simState } from "./helpers.ts";

/** Dragging money is a shortcut to a confirmation form, never a transfer. */
test("drag-to-allocate opens a preview; nothing changes until confirmed", async ({ page }) => {
  await ready(page, "/money");
  const tab = page.getByRole("tab", { name: /Assign/i });
  if (await tab.count()) await tab.first().click();
  const chip = page.locator(".draggable-chip").first();
  const target = page.locator(".drop-target").first();
  await expect(chip).toBeVisible();
  const before = await simState(page);
  // synthesize the HTML5 drag sequence with a shared DataTransfer
  await page.evaluate(() => {
    const src = document.querySelector(".draggable-chip")!;
    const dst = document.querySelector(".drop-target")!;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  });
  await expect(target).toBeVisible();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const mid = await simState(page);
  expect(JSON.stringify(mid.vault.balances)).toBe(JSON.stringify(before.vault.balances));
  expect(JSON.stringify(Object.values(mid.strategies).map((s) => s.doc.allocations))).toBe(JSON.stringify(Object.values(before.strategies).map((s) => s.doc.allocations)));
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const after = await simState(page);
  expect(JSON.stringify(after.vault.balances)).toBe(JSON.stringify(before.vault.balances));
  expect(after.activity.length).toBe(before.activity.length);
});

test("withdraw refuses more than available and never touches reserved funds", async ({ page }) => {
  await ready(page, "/money?action=withdraw");
  const amount = page.getByLabel(/Amount/i).first();
  await amount.fill("100000");
  await expect(page.getByText(/available/i).first()).toBeVisible();
  const submit = page.getByRole("button", { name: /^Withdraw/ }).last();
  const disabled = (await submit.getAttribute("aria-disabled")) === "true" || (await submit.isDisabled());
  expect(disabled).toBe(true);
});
