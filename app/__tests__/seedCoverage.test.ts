// /app/__tests__/seedCoverage.test.ts
//
// The manifest must describe the schema exactly — every model, nothing invented.
//
// This is the half that runs without a database. The other half
// (`npm run seed:coverage`) measures a seeded database against the same
// manifest; CI runs it in the smoke job, which already builds one.
//
// Why a manifest at all: an empty table looks identical whether the feature is
// unseeded, the seed module silently stopped running, or nobody ever wrote it.
// Declaring the intent is what makes the difference detectable.

import { readFileSync } from "fs";
import { join } from "path";
import { SEED_COVERAGE, SEED_TRANCHES, modelsInTranche } from "../prisma/seed/coverage";

const SCHEMA = join(__dirname, "..", "prisma", "schema.prisma");

function modelsInSchema(): string[] {
  const src = readFileSync(SCHEMA, "utf8");
  return [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]).sort();
}

describe("seed coverage manifest matches the schema", () => {
  it("classifies every model in schema.prisma", () => {
    // A new model that nobody classified is the exact silent gap this prevents.
    const missing = modelsInSchema().filter((m) => !(m in SEED_COVERAGE));
    expect(missing).toEqual([]);
  });

  it("names no model the schema does not declare", () => {
    // Catches a rename or a deletion leaving a stale row behind.
    const schema = new Set(modelsInSchema());
    const phantom = Object.keys(SEED_COVERAGE).filter((m) => !schema.has(m));
    expect(phantom).toEqual([]);
  });

  it("finds the models it was written for, so the scan is not silently empty", () => {
    // If the regex stops matching, every other test here passes vacuously.
    const models = modelsInSchema();
    expect(models.length).toBeGreaterThan(150);
    expect(models).toContain("SalesOrder");
    expect(models).toContain("JournalEntry");
  });
});

describe("every classification carries what it owes", () => {
  it("gives each skipped model a real reason", () => {
    // "skipped" without a reason is indistinguishable from "forgotten".
    for (const [model, entry] of Object.entries(SEED_COVERAGE)) {
      if (entry.status !== "skipped") continue;
      expect(typeof entry.reason).toBe("string");
      expect((entry.reason ?? "").length).toBeGreaterThan(30);
    }
  });

  it("assigns each todo model to a declared tranche", () => {
    // The tranche is the unit of delegation; a todo without one is unassignable.
    for (const [model, entry] of Object.entries(SEED_COVERAGE)) {
      if (entry.status !== "todo") continue;
      expect(SEED_TRANCHES).toContain(entry.tranche);
    }
  });

  it("leaves seeded models with neither a reason nor a tranche", () => {
    // Those fields describe work outstanding. Carrying them once the work is
    // done is how a manifest starts lying.
    for (const [model, entry] of Object.entries(SEED_COVERAGE)) {
      if (entry.status !== "seeded") continue;
      expect(entry.reason).toBeUndefined();
      expect(entry.tranche).toBeUndefined();
    }
  });

  it("declares no empty tranche", () => {
    for (const tranche of SEED_TRANCHES) {
      expect(modelsInTranche(tranche).length).toBeGreaterThan(0);
    }
  });

  it("secrets and PII are skipped, never merely outstanding", () => {
    // These must not drift into `todo`, where someone could pick them up in
    // good faith. holt is a public repo.
    for (const model of ["IntegrationCredential", "WindfallEnrichment", "Session"]) {
      expect(SEED_COVERAGE[model]?.status).toBe("skipped");
    }
  });
});
