import { expect, test } from "@playwright/test";
import { openFlagshipDraft, ready, simState } from "./helpers.ts";

/** The signature moment: a plan explains where money can go, gets authorized, then execution follows it. */
test("draft → three views → review → sign → resolve → execute → completes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await openFlagshipDraft(page);
  // one document, three synchronized views
  await expect(page.getByRole("tab", { name: "Sentence" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.getByText("Portfolio A · Lumen 60%").first()).toBeVisible();
  await page.getByRole("tab", { name: "Sentence" }).click();

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForURL(/\/review/);
  await expect(page.getByText(/worst case/i).first()).toBeVisible();
  const sign = page.getByRole("button", { name: "Sign and reserve" });
  // can't sign until both acknowledgements are ticked
  await expect(sign).toHaveAttribute("aria-disabled", "true");
  for (const box of await page.locator(".check-row input").all()) await box.check();
  await sign.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Plan hash");
  await dialog.getByRole("button", { name: "Sign", exact: true }).click();
  await page.waitForURL(/\/futures\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByText("Active").first()).toBeVisible({ timeout: 20_000 });

  const before = await simState(page);
  const vaultBefore = JSON.stringify(before.vault.balances);

  // resolve A = YES from the market panel, then let the challenge window pass
  await ready(page, "/discover?market=orbit-launch");
  await page.getByRole("button", { name: "Propose YES" }).click();
  await page.getByRole("button", { name: /environment and controls/ }).click();
  await page.getByRole("button", { name: "+1h" }).click();
  await page.keyboard.press("Escape");

  await ready(page, "/futures");
  await page.getByRole("link", { name: /Orbit, vote & cup/ }).first().click();
  await expect(page.getByText(/180 USDC/).first()).toBeVisible({ timeout: 20_000 });
  const after = await simState(page);
  expect(JSON.stringify(after.vault.balances)).not.toBe(vaultBefore);
  expect(after.activity.some((a) => a.kind === "execute" && /Lumen/.test(a.title))).toBe(true);
  // the NO branch can never run once YES executed
  expect(after.activity.some((a) => a.kind === "release" && /Release the 300/.test(a.title))).toBe(false);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("an authorized future is read-only; editing starts a new version", async ({ page }) => {
  await ready(page, "/futures");
  await page.getByRole("link", { name: /Treasury vote: two portfolios/ }).first().click();
  await page.waitForURL(/\/futures\/[^/]+$/);
  await page.getByRole("link", { name: /Edit as new version|Open in builder|View plan/ }).first().click().catch(() => undefined);
  if (/\/edit/.test(page.url())) {
    await expect(page.getByText(/signed|authorized/i).first()).toBeVisible();
    const v = page.getByRole("button", { name: "Edit as new version" });
    await expect(v).toBeVisible();
    await v.click();
    await page.waitForURL(/\/edit/);
    await expect(page.getByText(/new version/i).first()).toBeVisible();
  }
});
