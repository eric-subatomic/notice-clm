import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e/production",
  outputDir: "./work/playwright/production-test-results",
  globalSetup: "./tests/e2e/production/global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "./work/playwright/production-report" }]]
    : "list",
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "production-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
