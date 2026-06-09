// /app/__tests__/dependabotMajorWatchlist.test.ts
//
// Tripwire: keeps `.github/dependabot.yml`'s held-back-majors list in
// sync with ROADMAP.md's "Major Upgrade Watchlist."
//
// Why this exists: 2026-04-29 -- the original dependabot.yml shipped
// without `node` (Docker base image) or `@types/node` in the held-back
// majors list. Dependabot then opened PR #147 bumping Node 24 (LTS) to
// Node 25 (Current, NOT LTS) which auto-merged via the patch+minor
// group cleanup batch. CI gates didn't catch it because the violation
// is a CONVENTION (rule 5 = LTS-only), not a test failure -- node:25
// builds fine and tests pass; the rule about LTS lives in CLAUDE.md
// and ROADMAP, not in any code path.
//
// This test catches drift in either direction:
//   - A package added to ROADMAP "Major Upgrade Watchlist" but missing
//     from dependabot.yml ignore -> Dependabot would auto-bump it.
//   - A package in dependabot.yml ignore but not in ROADMAP -> stale
//     hold without a documented reason.
//
// Pure source-text test (B-grade per the test grading rubric in the
// SOR plan Phase 0.6). No DB / no network. Cheap to run.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const DEPENDABOT_PATH = join(REPO_ROOT, ".github", "dependabot.yml");
const ROADMAP_PATH = join(REPO_ROOT, "ROADMAP.md");

/**
 * Extract the set of dependency names that have a
 * `version-update:semver-major` ignore in dependabot.yml. The YAML
 * is well-known; we parse it with regex rather than pulling in a YAML
 * parser dep (KISS + we control the file shape).
 */
function dependabotHeldBackMajors(): Set<string> {
  const raw = readFileSync(DEPENDABOT_PATH, "utf8");
  const held = new Set<string>();
  // Match each pair: `dependency-name: "X"` followed (possibly with
  // a comment line) by an `update-types: [...semver-major...]`.
  // Capture the dependency name.
  const blockRegex =
    /dependency-name:\s*"([^"]+)"[\s\S]*?update-types:\s*\[[^\]]*"version-update:semver-major"[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(raw)) !== null) {
    held.add(m[1]);
  }
  return held;
}

/**
 * Extract dependency names from the ROADMAP "Major Upgrade Watchlist"
 * markdown table. The table has a column with backtick-wrapped
 * package names in the first cell of each data row.
 */
function roadmapMajorWatchlist(): Set<string> {
  const raw = readFileSync(ROADMAP_PATH, "utf8");
  const watchlistStart = raw.indexOf("## Major Upgrade Watchlist");
  if (watchlistStart === -1) {
    throw new Error('ROADMAP.md is missing the "## Major Upgrade Watchlist" section');
  }
  // Take from the heading to the next `---` or end of file.
  const tail = raw.slice(watchlistStart);
  const sectionEnd = tail.indexOf("\n---\n");
  const section = sectionEnd === -1 ? tail : tail.slice(0, sectionEnd);

  const watch = new Set<string>();
  // Each table row: `| <first-cell> | ...`
  // First cell may contain MULTIPLE backtick-wrapped names joined by
  // " + " (e.g. "`jest` + `@types/jest`"). Capture all of them.
  // Skip header row and separator (`|---|`).
  const rowRegex = /^\|\s*([^|]+?)\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(section)) !== null) {
    const cell = m[1];
    if (cell.startsWith("---") || cell.toLowerCase() === "package") continue;
    // Pull every backtick-wrapped token from the cell.
    const nameRegex = /`([^`]+)`/g;
    let nm: RegExpExecArray | null;
    while ((nm = nameRegex.exec(cell)) !== null) {
      watch.add(nm[1]);
    }
  }
  return watch;
}

describe("dependabot ignore-list ↔ ROADMAP major watchlist", () => {
  it("every package in ROADMAP Major Upgrade Watchlist is held back in dependabot.yml", () => {
    const watchlist = roadmapMajorWatchlist();
    const dependabot = dependabotHeldBackMajors();

    expect(watchlist.size).toBeGreaterThan(0); // sanity: ROADMAP parsed
    expect(dependabot.size).toBeGreaterThan(0); // sanity: dependabot parsed

    const missing: string[] = [];
    for (const pkg of watchlist) {
      if (!dependabot.has(pkg)) missing.push(pkg);
    }

    if (missing.length > 0) {
      throw new Error(
        `dependabot.yml is missing semver-major holds for: ${missing.join(", ")}.\n` +
          `These are in ROADMAP.md "Major Upgrade Watchlist" but Dependabot would auto-bump them.\n` +
          `Add each to .github/dependabot.yml as:\n` +
          `  - dependency-name: "<name>"\n` +
          `    update-types: ["version-update:semver-major"]`,
      );
    }
  });

  it("every package held back in dependabot.yml has a documented reason in ROADMAP", () => {
    // Allow some packages to be held back for reasons OTHER than the
    // ROADMAP watchlist (e.g. node Docker base image where the reason
    // is "LTS only" -- a CLAUDE.md rule 5 thing, not a planned upgrade).
    // Maintain this allowlist explicitly so additions are intentional.
    const ALLOW_HELD_WITHOUT_ROADMAP = new Set([
      "node", // CLAUDE.md rule 5: LTS-only Docker base image
      "@types/node", // pairs with node runtime; major bumps deliberate
      "next-auth", // ROADMAP "Not on the watchlist": v5 still beta as of 2026-04-23
    ]);

    const watchlist = roadmapMajorWatchlist();
    const dependabot = dependabotHeldBackMajors();

    const orphans: string[] = [];
    for (const pkg of dependabot) {
      if (!watchlist.has(pkg) && !ALLOW_HELD_WITHOUT_ROADMAP.has(pkg)) {
        orphans.push(pkg);
      }
    }

    if (orphans.length > 0) {
      throw new Error(
        `dependabot.yml holds back majors for packages NOT in ROADMAP "Major Upgrade Watchlist": ${orphans.join(", ")}.\n` +
          `Either:\n` +
          `  (a) add a row to ROADMAP.md "Major Upgrade Watchlist" with a reason, OR\n` +
          `  (b) remove the ignore from dependabot.yml, OR\n` +
          `  (c) add the package to ALLOW_HELD_WITHOUT_ROADMAP in this test with a comment explaining why.`,
      );
    }
  });

  it("includes the runtime-pinned packages that caught us 2026-04-29", () => {
    // Tripwire for the specific failure mode: node Docker base + @types/node.
    // Removing either of these from dependabot.yml fails this test even if
    // ROADMAP doesn't list them.
    const dependabot = dependabotHeldBackMajors();
    expect(dependabot.has("node")).toBe(true);
    expect(dependabot.has("@types/node")).toBe(true);
  });
});
