// /app/__tests__/sourceAdapterSeam.test.ts
//
// Source-text tripwire: the seam is only real while nothing routes around it.
//
// The Ordorite folder was already swappable in practice -- one production call
// site -- but nothing enforced that, so it stayed true by luck. The first
// route that imports `runGmailImport` directly for a "quick fix" makes
// "replace the source system with anything" false again, and nothing would
// have failed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

/** Every .ts/.tsx under src/, excluding the adapters folder itself. */
function sourceFilesOutsideAdapters(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full.endsWith(join("src", "lib", "adapters"))) continue;
      sourceFilesOutsideAdapters(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// The test harness clears module-level caches inside the adapter after a
// TRUNCATE. That is test plumbing reaching into implementation on purpose, not
// production code taking a shortcut past the interface.
const ALLOWED = [join("src", "lib", "testing", "withTestDb.ts")];

describe("source adapter seam", () => {
  const files = sourceFilesOutsideAdapters(SRC);

  it("finds source files to check (guards against a broken walker)", () => {
    // A test that scans nothing passes forever. This is the assertion that
    // makes the two below mean something.
    expect(files.length).toBeGreaterThan(300);
  });

  it("nothing outside lib/adapters/ imports an adapter's internals", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.some((a) => file.endsWith(a))) continue;
      const text = readFileSync(file, "utf-8");
      // Import statements only -- prose in a comment naming the folder (for
      // provenance, which is encouraged) is not a coupling.
      const importsInternals = /\bfrom\s+["']@?\/?[^"']*lib\/adapters\/[a-z]/i.test(
        text
          .split("\n")
          .filter((l) => /^\s*(import|export)\s/.test(l))
          .join("\n"),
      );
      if (importsInternals) offenders.push(file.slice(file.indexOf("src/")));
    }
    expect(offenders).toEqual([]);
  });

  it("the import route resolves through the registry, not a named adapter", () => {
    const route = readFileSync(
      join(SRC, "pages", "api", "automations", "source-import.ts"),
      "utf-8",
    );
    expect(route).toContain("getActiveSourceAdapter");
    // Imports only. The route's header explains WHY the seam exists and names
    // Ordorite as the motivating case — that provenance is worth keeping, and
    // a comment is not a coupling.
    const importLines = route
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l))
      .join("\n");
    expect(importLines).not.toMatch(/runGmailImport|ordorite/i);
  });
});
