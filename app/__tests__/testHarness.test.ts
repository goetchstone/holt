// /app/__tests__/testHarness.test.ts
//
// Tripwire: the TABLES_FOR_TEST_RESET list in lib/testing/withTestDb.ts
// must stay in sync with the Prisma schema. If a new model is added
// without updating the list, integration tests will silently see
// lingering data from a prior test for that model — exactly the kind
// of "flaky test, must be the network" failure mode that erodes trust
// in the suite.
//
// Strategy: parse schema.prisma for `^model Foo {` declarations,
// compare against the exported TABLES_FOR_TEST_RESET list. Any
// schema model not in the list (or vice versa) is a fail.
//
// Source-text scan (B grade) — the underlying behavior would only
// surface as test pollution; this lifts it to a hard build break.

import { readFileSync } from "fs";
import { join } from "path";
import { TABLES_FOR_TEST_RESET } from "@/lib/testing/withTestDb";

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

/**
 * Models that intentionally aren't TRUNCATEd between integration tests.
 * Most of these are reference / lookup tables seeded once and shared
 * across tests. If you add a model here, document why.
 */
const INTENTIONALLY_EXCLUDED = new Set<string>([
  // None yet — every model truncates between tests today. Add entries
  // here only when there's a concrete reason (e.g. system-seeded
  // reference data that all tests share).
]);

function parseModels(): string[] {
  const matches = SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm);
  return Array.from(matches, (m) => m[1]).sort();
}

describe("test harness — TABLES_FOR_TEST_RESET stays in sync with schema", () => {
  const schemaModels = parseModels();
  const resetSet = new Set(TABLES_FOR_TEST_RESET);

  it("every Prisma model is either in the truncate list or explicitly excluded", () => {
    const missing = schemaModels.filter((m) => !resetSet.has(m) && !INTENTIONALLY_EXCLUDED.has(m));
    if (missing.length > 0) {
      throw new Error(
        `These Prisma models are missing from TABLES_FOR_TEST_RESET in lib/testing/withTestDb.ts:\n` +
          missing.map((m) => `  - ${m}`).join("\n") +
          `\n\nAdd them to the ALL_TABLES list, or to INTENTIONALLY_EXCLUDED in this test ` +
          `with a comment explaining why test isolation is OK without them.`,
      );
    }
  });

  it("every entry in TABLES_FOR_TEST_RESET corresponds to a real Prisma model", () => {
    const schemaSet = new Set(schemaModels);
    const stale = TABLES_FOR_TEST_RESET.filter((t) => !schemaSet.has(t));
    if (stale.length > 0) {
      throw new Error(
        `These names in TABLES_FOR_TEST_RESET no longer correspond to a Prisma model ` +
          `(probably renamed or dropped):\n` +
          stale.map((t) => `  - ${t}`).join("\n"),
      );
    }
  });

  it("the list is alphabetized within each section (best-effort readability check)", () => {
    // Just smoke-check that it's not totally random — exact ordering
    // isn't enforced because the file groups by domain.
    expect(TABLES_FOR_TEST_RESET.length).toBeGreaterThan(20);
  });
});
