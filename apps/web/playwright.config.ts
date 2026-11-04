import { defineConfig } from "@playwright/test";

/**
 * Browser tests run against the in-browser simulation (no chain needed).
 * Chromium only: it's the browser installed in this environment.
 *   pnpm --filter @maybe/web e2e
 */
const PORT = Number(process.env.MAYBE_E2E_WEB_PORT ?? 5175);
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.output/artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [["list"], ["json", { outputFile: "e2e/.output/results.json" }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { VITE_MAYBE_API: "off" },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "laptop", use: { viewport: { width: 1024, height: 768 } }, grep: /@responsive/ },
    { name: "mobile", use: mobile, grep: /@responsive|@mobile/ },
  ],
});
