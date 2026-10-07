// /app/__tests__/testGrading.test.ts
//
// PHASE 0.6.2 — placeholder-test header enforcement.
//
// Every test file that mocks Prisma (via jest.mock("@prisma/client")
// or jest.mock("@/lib/prisma")) must carry a header comment declaring
// its grade per the Phase 0.6 rubric:
//
//   // PLACEHOLDER TEST — Grade: <grade>
//   // <upgrade path: real-DB integration test issue/PR/phase>
//
// Why this rule exists
// --------------------
// Mocked-Prisma tests verify wiring (the right method gets called
// with the right args). They don't verify SQL behavior — actual
// filter matching, FK resolution, enum drift, query result shapes.
// Every April 2026 production bug we shipped was that bug shape.
//
// We're not banning mocked-Prisma tests outright (Phase 0.6.3 is the
// rolling conversion plan). But every one that exists today must be
// VISIBLY MARKED as placeholder so the upgrade work is trackable in
// code review, in lint output, and in this test's failure message.
//
// Strategy
// --------
// Glob every *.test.ts file under __tests__/. Skip the integration
// directory (those are by definition not placeholders). For each
// remaining file, check if it imports/mocks Prisma. If yes, require
// the placeholder header anywhere in the first 50 lines.
//
// The first failure listing here is the canonical inventory of
// placeholder tests we owe Phase 0.6.3 conversions for.

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const TESTS_DIR = join(__dirname);

const PRISMA_MOCK_PATTERNS = [
  /jest\.mock\(\s*['"]@prisma\/client['"]/,
  /jest\.mock\(\s*['"]@\/lib\/prisma['"]/,
  /jest\.mock\(\s*['"]\.\.?\/.*\/lib\/prisma['"]/,
];

// Accept one or more dashes (single hyphen, double hyphen, em-dash) so
// existing headers like "// PLACEHOLDER TEST -- Grade: C+" (used in
// mailchimpAudienceSync.runner.test.ts since 2026-04-25) pass without
// reformatting.
const PLACEHOLDER_HEADER_PATTERN = /\/\/\s*PLACEHOLDER TEST\s*[-—]+\s*Grade:/i;

/**
 * Walk a directory recursively and yield every *.test.ts file path,
 * excluding the integration subdirectory (real-DB tests are not
 * placeholders by definition).
 */
function* walkTestFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Skip the integration directory — those are real-DB tests, not
      // placeholders.
      if (name === "integration") continue;
      // Skip the __mocks__ helpers directory.
      if (name === "__mocks__" || name === "lib" || name === "helpers") continue;
      yield* walkTestFiles(fullPath);
    } else if (name.endsWith(".test.ts")) {
      yield fullPath;
    }
  }
}

function mocksPrisma(source: string): boolean {
  return PRISMA_MOCK_PATTERNS.some((p) => p.test(source));
}

function hasPlaceholderHeader(source: string): boolean {
  // Only the first 50 lines count — it has to be a header, not buried.
  const head = source.split("\n").slice(0, 50).join("\n");
  return PLACEHOLDER_HEADER_PATTERN.test(head);
}

describe("test grading — every Prisma-mocking test must declare placeholder status", () => {
  const violations: string[] = [];
  for (const file of walkTestFiles(TESTS_DIR)) {
    const source = readFileSync(file, "utf8");
    if (mocksPrisma(source) && !hasPlaceholderHeader(source)) {
      violations.push(file.replace(__dirname, "__tests__"));
    }
  }

  it("all Prisma-mocking tests have a `// PLACEHOLDER TEST — Grade: X` header", () => {
    if (violations.length > 0) {
      throw new Error(
        `These test files mock Prisma but have no placeholder-status header:\n\n` +
          violations.map((f) => `  - ${f}`).join("\n") +
          `\n\nAdd a header to each (within the first 50 lines), e.g.:\n\n` +
          `  // PLACEHOLDER TEST — Grade: C+\n` +
          `  // Mocked-Prisma orchestration test. Tracked for upgrade to A/B grade\n` +
          `  // in Phase 0.6.3 (real-DB integration test). See plan file.\n\n` +
          `Or convert the test to a real-DB integration test under\n` +
          `__tests__/integration/ (preferred path forward).`,
      );
    }
  });

  it("the integration directory is excluded from placeholder enforcement", () => {
    // Self-test: integration tests are real-DB by definition; the
    // walk should never have included one in the violations list even
    // if it happened to import jest.mock for some reason.
    expect(violations.some((v) => v.includes("/integration/"))).toBe(false);
  });
});
