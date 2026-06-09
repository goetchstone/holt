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
//   2. Bearer-token auth via AUTO_IMPORT_API_KEY is implemented (cron
//      compatibility — Synology calls the endpoint without a session).
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

  it("implements Bearer-token auth via AUTO_IMPORT_API_KEY", () => {
    expect(ENDPOINT_SRC).toMatch(/process\.env\.AUTO_IMPORT_API_KEY/);
    expect(ENDPOINT_SRC).toMatch(/Bearer\s*\$\{apiKey\}|Bearer \$\{apiKey\}/);
  });

  it("falls back to NextAuth session for admin-UI manual triggers", () => {
    expect(ENDPOINT_SRC).toMatch(/getServerSession\(req,\s*res,\s*authOptions\)/);
  });

  it("writes a DailyReconciliationLog row per reconciled day", () => {
    expect(ENDPOINT_SRC).toMatch(/prisma\.dailyReconciliationLog\.create/);
  });

  it("returns the response under POST only (rejects other methods with 405)", () => {
    expect(ENDPOINT_SRC).toMatch(/req\.method\s*!==\s*"POST"/);
    expect(ENDPOINT_SRC).toMatch(/setHeader\("Allow",\s*\["POST"\]\)/);
  });
});
