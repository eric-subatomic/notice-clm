import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.NOTICE_E2E_PORT ?? 43_117);
if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("NOTICE_E2E_PORT must be an available user port.");
}

const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "**/production/**",
  outputDir: "./work/playwright/test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "./work/playwright/report" }]]
    : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev:evaluation -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/api/session`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
