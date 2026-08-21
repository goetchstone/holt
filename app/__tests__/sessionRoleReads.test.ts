// /app/__tests__/sessionRoleReads.test.ts
//
// No route may decide authorization from the role on the SESSION.
//
// The JWT is minted at sign-in and never revisited. A staff member who is
// demoted, or deactivated entirely, keeps whatever the token says until it
// expires -- so a route branching on `session.role` grants access that
// offboarding did not revoke. requireAuth.ts documents this as the reason
// requireAuthWithRole reads StaffMember with `isActive: true` on every request;
// reading the role off the session reopens the hole one route at a time.
//
// Use requirePermission, requireAuthWithRole, or activeStaffRole() -- all three
// read the database. activeStaffRole exists for routes that also accept a
// machine Bearer token for cron and so cannot simply be wrapped.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const API_DIRS = [
  join(__dirname, "..", "src", "pages", "api"),
  join(__dirname, "..", "src", "app", "api"),
];
const APP_ROOT = join(__dirname, "..");

/**
 * Files allowed to touch a session role, with the reason.
 *
 * The token issuer is the one place that legitimately WRITES the role onto the
 * token. Anything else here would be a hole with a note attached.
 */
const ALLOWED: Record<string, string> = {
  "src/pages/api/auth/[...nextauth].ts":
    "The token issuer. It writes the role onto the JWT at sign-in; it is the source, not a consumer making an authorization decision.",
  "src/pages/api/reports/sales-by-salesperson/export.ts":
    "Passes session.role into resolveSalesPersonFilter for the DESIGNER self-lock, which RESTRICTS what the caller sees rather than granting access. A stale role here can only narrow the result set, never widen it. Tracked for migration with the rest of the report lib.",
};

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Strip comments so prose about the hazard does not read as the hazard. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SESSION_ROLE =
  /session\s*(?:as\s*\{[^}]*\}\s*)?\)?\s*(?:\||\?)?\.?\s*(?:\?\.)?\s*(?:user\s*(?:\?\.)?\s*)?\.?\s*role\b|\.role\s*;/;

function readsSessionRole(src: string): boolean {
  const code = codeOf(src);
  return code
    .split("\n")
    .some(
      (line) =>
        /\bsession\b/.test(line) &&
        /\brole\b/.test(line) &&
        !/activeStaffRole/.test(line) &&
        !/staff\?\.role|staff\.role/.test(line),
    );
}

describe("authorization never trusts the role on the session", () => {
  const files = API_DIRS.flatMap(walk);

  it("finds the routes it was written for, so the scan is not silently empty", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no API route branches on a session role", () => {
    const offenders = files
      .filter((f) => readsSessionRole(readFileSync(f, "utf8")))
      .map((f) => relative(APP_ROOT, f))
      .filter((rel) => !(rel in ALLOWED));
    expect(offenders).toEqual([]);
  });

  it("every allowance names a file that still exists and still needs it", () => {
    // A stale allowance silently pre-approves a future reintroduction.
    const present = new Set(files.map((f) => relative(APP_ROOT, f)));
    for (const rel of Object.keys(ALLOWED)) {
      expect(present.has(rel)).toBe(true);
      expect(ALLOWED[rel].length).toBeGreaterThan(60);
    }
  });
});
