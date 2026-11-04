import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The public Odds board (odds.html → src/site). This environment can't reach Solana mainnet, so these
 * checks cover the page itself: structure, controls, accessibility and layout at every size. Live data
 * is checked against the deployed site in a real browser.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function openBoard(page: Page) {
  await page.goto("/odds.html");
  await expect(page.getByRole("heading", { name: "Live odds on pump.fun tokens" })).toBeAttached();
  await expect(page.getByRole("status").filter({ visible: true }).first()).toBeVisible();
}

test("the board lays out at every size without sideways scrolling @responsive", async ({ page }, info) => {
  await openBoard(page);
  const narrow = (page.viewportSize()?.width ?? 1440) <= 900;
  if (narrow) {
    await expect(page.getByRole("tab", { name: /Just launched/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /Graduated/ }).click();
    await expect(page.getByRole("region", { name: "Graduated" })).toBeVisible();
  } else {
    for (const name of ["Just launched", "Final stretch", "Graduated"]) await expect(page.getByRole("region", { name })).toBeVisible();
  }
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `page is ${r.sw}px wide in a ${r.w}px viewport`).toBeLessThanOrEqual(r.w + 1);
  // the balance and the explainer are reachable at every size, wherever they sit
  await expect(page.getByRole("button", { name: /practice SOL/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "How Odds works" })).toBeVisible();
  const dir = `e2e/.output/shots/${info.project.name}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/odds-board.png` });
});

test("axe finds nothing serious on the board or its explainer @responsive", async ({ page }) => {
  await openBoard(page);
  const board = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(board.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await page.getByRole("button", { name: "How Odds works" }).click();
  await expect(page.getByRole("dialog", { name: "How Odds works" })).toBeVisible();
  const modal = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(modal.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
});

test("stake per tap and the practice balance persist across visits", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByRole("button", { name: /^10\.00 practice SOL/ })).toBeVisible();
  const group = page.getByRole("group", { name: /Stake per tap/ });
  await group.getByRole("button", { name: "0.5" }).click();
  await expect(group.getByRole("button", { name: "0.5" })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("group", { name: /Stake per tap/ }).getByRole("button", { name: "0.5" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /practice SOL/ }).click();
  await expect(page.getByRole("dialog", { name: "Practice positions" })).toBeVisible();
  await expect(page.getByText("No open positions.", { exact: false })).toBeVisible();
});

test("the public page has no wallet and no simulated balances", async ({ page }) => {
  await openBoard(page);
  await expect(page.getByRole("button", { name: /Connect/ })).toHaveCount(0);
  await expect(page.getByText("2,500")).toHaveCount(0);
});
