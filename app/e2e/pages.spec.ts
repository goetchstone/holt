// /app/e2e/pages.spec.ts
//
// Opens every App Router page in a real browser and fails on anything a person
// opening it would see go wrong: an HTTP error, a redirect, an uncaught client
// error, a console error, a failed call to the app's own API, or the
// error-boundary screen. It runs twice (playwright.config.ts projects): as the
// seeded Owner, who holds every permission, so every page must render at its
// own address; and as the seeded Administrator, for whom a page that refuses
// them (requirePage sends them to /app) is skipped, and a page that admits them
// must work, which is how a page gate wider than its API's shows up. Six PRs (#118 to #124)
// shipped screens that no test and no person had opened; unit and integration
// tests never render a page, and scripts/smoke.sh fetches one.
//
// Static routes are opened as they are; dynamic routes take their parameters
// from e2e/dynamicRoutes.ts. A page whose module is off on this deployment is
// skipped and says so (CI switches every module on). A page in
// e2e/knownFailures.ts is expected to fail until its fix lands.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { isFeatureEnabled } from "../src/lib/featureCatalog";
import { DYNAMIC_ROUTES } from "./dynamicRoutes";
import { KNOWN_FAILURES } from "./knownFailures";
import { isDynamic, moduleOf, pageRoutes } from "./pageRoutes";
import { REDIRECTS } from "./redirects";
import { FEATURES_FILE, type SignInName } from "./signIn";

/** Text only an error screen shows. */
const ERROR_SCREENS = ["Something went wrong", "Application error", "This page could not be found"];

let db: PrismaClient | null = null;
function database(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set for dynamic routes");
  db ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  return db;
}

test.afterAll(async () => {
  await db?.$disconnect();
});

/** Collects what goes wrong while the page loads. */
function watch(page: Page, origin: string): string[] {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    const kind = r.request().resourceType();
    if (url.origin === origin && r.status() >= 400 && (kind === "fetch" || kind === "xhr")) {
      problems.push(`${r.status()} ${r.request().method()} ${url.pathname}`);
    }
  });
  return problems;
}

/** The deployment's module switches, as signIn.ts recorded them. */
function features(): Record<string, boolean> {
  return JSON.parse(readFileSync(FEATURES_FILE, "utf8")) as Record<string, boolean>;
}

/** The sign-in page, where requirePage sends a visitor it does not admit. */
const SIGN_IN = /^\/auth\/login(\/|$)/;

for (const route of pageRoutes()) {
  const entry = isDynamic(route) ? DYNAMIC_ROUTES[route] : undefined;
  if (entry && "skip" in entry) {
    test.skip(`${route} (${entry.skip})`, () => {});
    continue;
  }

  test(route, async ({ page, baseURL }, testInfo) => {
    const as = testInfo.project.name as SignInName;
    const requiredModule = moduleOf(route);
    test.skip(
      requiredModule !== null && !isFeatureEnabled(features(), requiredModule),
      `module ${requiredModule} is off on this deployment`,
    );
    const knownFailure = KNOWN_FAILURES[route];
    test.fail(knownFailure?.as === as, knownFailure?.reason);

    let url: string | null = route;
    if (isDynamic(route)) {
      if (!entry) throw new Error(`${route} has no entry in e2e/dynamicRoutes.ts`);
      url = await entry.find(database());
      if (url === null) {
        test.skip(!process.env.CI, `this database has nothing to open ${route} with`);
        throw new Error(`the seed has nothing to open ${route} with (e2e/dynamicRoutes.ts)`);
      }
    }

    const origin = new URL(baseURL!).origin;
    const problems = watch(page, origin);
    const response = await page.goto(url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    expect(response?.status(), "HTTP status").toBeLessThan(400);
    const landed = decodeURIComponent(new URL(page.url()).pathname);
    expect(landed, "redirected to sign-in").not.toMatch(SIGN_IN);
    // Where this page should land: itself, or where e2e/redirects.ts says.
    const expected = REDIRECTS[route]?.to ?? decodeURIComponent(new URL(url, baseURL).pathname);
    // requirePage sends a signed-in person it does not admit to /app. The Owner
    // is admitted everywhere, so for them any other redirect is a failure: the
    // page was never rendered, and passing it would claim a page nobody opened.
    test.skip(
      as !== "owner" && landed === "/app" && expected !== "/app",
      `the ${as} is not admitted to ${route}`,
    );
    expect(landed, "redirected").toBe(expected);
    const body = await page.locator("body").innerText();
    for (const text of ERROR_SCREENS) expect(body, "error screen").not.toContain(text);
    expect(problems).toEqual([]);
  });
}
