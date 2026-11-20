// /app/playwright.config.ts
//
// The browser smoke suite (e2e/). Opens every App Router page in a real
// browser as a signed-in admin against a running, seeded app. Run with
// `npm run test:pages`; BASE_URL defaults to http://localhost:3000.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  globalSetup: "./e2e/signIn.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    storageState: "e2e/.auth/admin.json",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
