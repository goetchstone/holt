// /app/__tests__/reportApiAuthShape.test.ts
//
// Source-text tripwire — every authenticated report API endpoint must
// use the canonical `requireAuthWithRole(...)` wrapper from
// `lib/auth/requireAuth.ts`. Hand-rolling the role check off
// `session.user.role` silently 403s because NextAuth's session.user
// shape does NOT include `role` — that field lives on the
// `StaffMember` row keyed by `userId`. Bug class hit prod 2026-05-28
// on `/api/reports/traffic` and `/api/reports/traffic/export`; this
// test guards against the same pattern re-appearing in any future
// report endpoint.

import * as fs from "node:fs";
import * as path from "node:path";

const REPORTS_DIR = path.join(__dirname, "..", "src", "pages", "api", "reports");

/** Walk a directory tree returning every .ts file path. */
function walkTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("report API auth shape", () => {
  const files = walkTs(REPORTS_DIR);

  it("finds report endpoints to check (sanity)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("no endpoint hand-rolls a role check off `session.user.role`", () => {
    // The NextAuth session.user shape does NOT include `role`. Any
    // endpoint reading it directly will read `undefined` and 403.
    // The canonical pattern is `requireAuthWithRole([...], handler)`
    // which queries StaffMember.role via userId.
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      // Pattern: anything that destructures `role` off session.user
      // or reads `session.user.role` / `session?.user?.role` / casts
      // session.user to { role }.
      if (
        /session(?:\?)?\.user(?:\?)?\.role/.test(src) ||
        /session\.user as \{[^}]*role/.test(src) ||
        /from session\.user[^)]*\.role/.test(src)
      ) {
        offenders.push(path.relative(REPORTS_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every endpoint protects with `requireAuthWithRole` OR `requireAuth` OR is explicitly public", () => {
    const exemptions = new Set<string>([
      // Add exemptions here ONLY for explicitly public endpoints
      // (none currently exist in /api/reports). Format: relative
      // path under api/reports/, e.g. "public-thing.ts".
    ]);
    const unguarded: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPORTS_DIR, file);
      if (exemptions.has(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      const guarded =
        /requireAuthWithRole\s*\(/.test(src) ||
        /requireAuth\s*\(/.test(src) ||
        /withAuth\s*\(/.test(src) ||
        /getServerSession\s*\(/.test(src);
      if (!guarded) unguarded.push(rel);
    }
    expect(unguarded).toEqual([]);
  });
});
