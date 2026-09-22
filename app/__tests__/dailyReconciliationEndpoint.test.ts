// /app/__tests__/dailyReconciliationEndpoint.test.ts
//
// Source-text tripwire for /api/automations/daily-reconciliation.
// The endpoint is intentionally thin (auth + loop + log-write), so the
// orchestration math is covered by the existing
// dailyReconciliation.integration.test.ts against the underlying
// computeDailyReconciliation helper.
//
// What this file pins:
//   1. The endpoint imports the computeDailyReconciliation helper (not
//      a duplicated copy of the logic).
//   2. The endpoint is gated by guardAutomation, which carries the cron's
//      Bearer AUTO_IMPORT_API_KEY path and requires the admin.automations
//      permission for a human session — it no longer falls back to "any
//      authenticated session" (SEC-02).
//   3. The endpoint writes to DailyReconciliationLog (operator audit
//      trail — without this, re-runs would silently overwrite history).
//
// If a future refactor removes any of these, this test fails.

import { readFileSync } from "fs";
import path from "path";

const ENDPOINT_PATH = path.resolve(
  __dirname,
  "../src/pages/api/automations/daily-reconciliation.ts",
);
const ENDPOINT_SRC = readFileSync(ENDPOINT_PATH, "utf8");

describe("daily-reconciliation endpoint guards", () => {
  it("imports computeDailyReconciliation from the canonical helper", () => {
    expect(ENDPOINT_SRC).toMatch(
      /import\s*\{[\s\S]{0,200}?computeDailyReconciliation[\s\S]{0,100}?\}\s*from\s*"@\/lib\/dailyReconciliation"/,
    );
  });

  it("is gated by guardAutomation (the cron Bearer key + admin.automations)", () => {
    // The AUTO_IMPORT_API_KEY Bearer path and the permission check both live in
    // guardAutomation now, so the endpoint names the wrapper rather than the
    // mechanism. guardAutomation.test.ts pins that mechanism directly.
    expect(ENDPOINT_SRC).toMatch(
      /import\s*\{[^}]*guardAutomation[^}]*\}\s*from\s*"@\/lib\/automations\/guardAutomation"/,
    );
    expect(ENDPOINT_SRC).toMatch(/export default guardAutomation\(run\)/);
  });

  it("no longer admits any authenticated session (SEC-02)", () => {
    // The exact hole this replaced: `if (session?.user?.email) return true`.
    expect(ENDPOINT_SRC).not.toMatch(/session\?\.user\?\.email\)\s*return true/);
    expect(ENDPOINT_SRC).not.toMatch(/getServerSession\(/);
  });

  it("writes a DailyReconciliationLog row per reconciled day", () => {
    expect(ENDPOINT_SRC).toMatch(/prisma\.dailyReconciliationLog\.create/);
  });

  it("returns the response under POST only (rejects other methods with 405)", () => {
    expect(ENDPOINT_SRC).toMatch(/req\.method\s*!==\s*"POST"/);
    expect(ENDPOINT_SRC).toMatch(/setHeader\("Allow",\s*\["POST"\]\)/);
  });
});
