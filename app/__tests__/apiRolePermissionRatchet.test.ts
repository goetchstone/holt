// /app/__tests__/apiRolePermissionRatchet.test.ts
//
// The role-array backlog may shrink. It may not grow.
//
// These routes are not a hole -- requireAuthWithRole re-reads StaffMember with
// isActive on every request, so they revoke correctly. What they cannot do is
// answer "what can a DESIGNER do?" without a grep, which is the reason the
// permission layer exists at all.
//
// A ratchet rather than a migration, because converting one is a decision about
// ACCESS, not a refactor: for 91 of the original 121 the semantically correct
// permission admits or excludes a role the route does not today. Doing that
// silently in a cleanup is how a cleanup becomes an incident. So the list is
// frozen and a new role-array route has to displace an old one.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const APP_ROOT = join(__dirname, "..");
const LIST = join(__dirname, "fixtures", "role-array-api-routes.txt");

function listed(): string[] {
  return readFileSync(LIST, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.split(/\s{2,}/)[0].trim());
}

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function roleArrayRoutes(): string[] {
  return [join(APP_ROOT, "src", "pages", "api"), join(APP_ROOT, "src", "app", "api")]
    .flatMap(walk)
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      if (/requirePermission|withPermission/.test(src)) return false;
      return /requireAuthWithRole\(\s*\[/.test(src);
    })
    .map((f) => relative(APP_ROOT, f))
    .sort();
}

describe("the role-array backlog is a ratchet", () => {
  it("finds the routes it was written for, so the scan is not silently empty", () => {
    expect(listed().length).toBeGreaterThan(50);
  });

  it("adds no route that is not already on the list", () => {
    // A new role-array route, or one that regressed off a permission.
    const known = new Set(listed());
    expect(roleArrayRoutes().filter((r) => !known.has(r))).toEqual([]);
  });

  it("keeps no line for a route that has been converted or deleted", () => {
    // Stale lines overstate the backlog and quietly pre-approve a regression:
    // a converted route could revert to a role array and still pass above.
    const actual = new Set(roleArrayRoutes());
    expect(listed().filter((r) => !actual.has(r))).toEqual([]);
  });

  it("never grows past the count recorded when it was frozen", () => {
    // The number that matters. 121 routes were on role arrays; 30 converted
    // with provably identical access; the operating-role model took it to 83.
    expect(roleArrayRoutes().length).toBeLessThanOrEqual(83);
  });
});
