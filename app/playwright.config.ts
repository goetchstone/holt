// /app/playwright.config.ts
//
// The browser smoke suite (e2e/). Opens every App Router page in a real
// browser, once as the seeded Owner and once as the seeded Administrator,
// against a running, seeded app. Run with
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
    trace: "off",
  },
  // Project names are e2e/signIn.ts's SIGN_INS keys; pages.spec.ts reads them.
  projects: [
    { name: "owner", use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/owner.json" } },
    { name: "admin", use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/admin.json" } },
  ],
});
