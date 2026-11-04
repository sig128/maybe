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
  await expect(page.locator(".check-row input")).toHaveCount(2);
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
  await page.getByRole("dialog").getByRole("button", { name: "Propose YES" }).click();
  await expect(page.getByText(/YES proposed|Proposed YES/i).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: /environment and controls/ }).click();
  await page.getByRole("button", { name: "+1h" }).click();
  await page.keyboard.press("Escape");

  await ready(page, "/futures");
  await page.getByRole("link", { name: /Orbit, vote & cup/ }).first().click();
  await expect(page.getByText(/used 180\.00 USDC → got [\d.]+ LUMEN/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Other branch ran").first()).toBeVisible();
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
  const signedTitle = "Treasury vote: two portfolios";
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(signedTitle);
  await page.getByRole("link", { name: "View rules" }).click();
  await page.waitForURL(/\/edit$/);
  await expect(page.getByText("Authorized · read only")).toBeVisible();
  const original = page.url();
  await page.getByRole("button", { name: "Edit as new version" }).click();
  await page.waitForURL((u) => u.toString() !== original && /\/edit$/.test(u.toString()));
  await expect(page.getByText("Authorized · read only")).toHaveCount(0);
  // the signed version is untouched
  await page.goto(original.replace(/\/edit$/, ""));
  await expect(page.getByRole("heading", { level: 2 }).first()).toHaveText(signedTitle);
});
