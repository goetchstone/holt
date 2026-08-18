// /app/__tests__/apiReadRouteAuthorization.test.ts
//
// Every Pages Router API route must AUTHORIZE, not merely authenticate.
//
// COMPANION to apiRouteAuthorization.test.ts, which covers the MUTATING routes
// (POST/PUT/PATCH/DELETE) and their UNGATED_BY_DESIGN allowlist. That test came
// out of an audit of 146 mutating routes where a signed-in DESIGNER could
// refund a card. This one covers the other half: READS. 83 route files
// confirmed somebody was signed in and then returned customer names, phone
// numbers, pickup addresses and the whole customer book.
//
// Two files rather than one because the rules differ. A mutating route needs a
// gate, full stop. A read route needs a gate that matches the audience of the
// page in front of it -- too narrow 403s staff mid-workflow, which is a worse
// outcome for the business than the leak.
//
// The gap this closes: 83 route files called `getServerSession`, confirmed
// somebody was signed in, and proceeded. Any signed-in user of any role reached
// them. Several sat behind pages that ARE role-gated, which is what made it
// invisible — the UI looked restricted while the data was not. A hidden card is
// not a control.
//
// WHY THE POPULATION IS EVERY ROUTE, not just routes calling getServerSession.
// The first draft of this test checked only the latter, and a both-directions
// check killed it immediately: adding `requirePermission(...)` REPLACES the
// route's own `getServerSession` call, so every route this sweep fixed left the
// population the moment it was fixed. The guard could watch the debt list
// shrink but could never notice a gate being torn out again — the exact
// regression it exists to catch. Checking all 448 routes costs nothing and
// guards both directions.
//
// "Authorizes" means one of:
//   - requirePermission(...) / requireAuthWithRole(...) / requireAuth(...)
//   - an inline role check — several predate the helpers and are still real
//     gates. The original sweep's grep missed these and briefly "fixed" a route
//     that was already protected, WIDENING its audience. Hence this pattern.
//     It matches BOTH directions: `role !== "ADMIN"` guard clauses and
//     `role === "ADMIN" || …` allow clauses. A first draft caught only the
//     negation and so misread mailchimp/backfill-customer-links.ts — which uses
//     the positive form, and is already reasoned about in the companion test's
//     UNGATED_BY_DESIGN — as unguarded.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const APP_DIR = join(__dirname, "..");

/**
 * Routes that legitimately need no role or permission check.
 *
 * Keep this short and argued: an entry here is a route nobody looks at again.
 */
const EXEMPT: Record<string, string> = {
  "src/pages/api/auth/[...nextauth].ts":
    "The NextAuth handler itself — it establishes the session, so it cannot require one.",
  "src/pages/api/auth/forgot-password.ts":
    "Pre-authentication by definition: the caller has lost the ability to sign in.",
  "src/pages/api/auth/reset-password.ts":
    "Pre-authentication; authorized by a single-use emailed token, not a session.",
};

/**
 * Routes with no authorization control yet. DECLARED DEBT, not approval.
 *
 * Listed by name so the debt is counted rather than quietly excluded — the same
 * shape as KNOWN_RAW_SQL_SITES in salesRevenueStatusesSingleSource.test.ts.
 *
 * Regenerate after gating a batch:
 *   cd app && find src/pages/api -name '*.ts' | sort | while read f; do \
 *     grep -qE 'requirePermission\s*\(|requireAuthWithRole\s*\(|\brequireAuth\s*\(|(role|Role)\s*!==?\s*"' "$f" || echo "$f"; \
 *   done
 * then drop the EXEMPT entries.
 */
const KNOWN_UNGATED: string[] = readFileSync(
  join(__dirname, "fixtures", "ungated-read-api-routes.txt"),
  "utf8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const AUTHORIZES =
  /requirePermission\s*\(|requireAuthWithRole\s*\(|\brequireAuth\s*\(|(role|Role)\s*[!=]==?\s*"/;

function allApiRoutes(): string[] {
  return execFileSync("find", ["src/pages/api", "-name", "*.ts"], {
    cwd: APP_DIR,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
}

function authorizes(rel: string): boolean {
  return AUTHORIZES.test(readFileSync(join(APP_DIR, rel), "utf8"));
}

describe("API read routes authorize, not just authenticate", () => {
  it("no route authorizes nobody, unless exempt or declared debt", () => {
    const offenders = allApiRoutes()
      .filter((f) => !(f in EXEMPT))
      .filter((f) => !KNOWN_UNGATED.includes(f))
      .filter((f) => !authorizes(f));

    // Failing here means either a NEW route ships with no authorization, or a
    // gate was removed from one that had it. For a new route: copy the
    // permission from a sibling route doing the same job rather than inventing
    // a mapping, and check who reaches the page in front of it — many pages are
    // bare requirePage(), so lib/auth/navPermissions.ts is the real signal of
    // intended audience. Too narrow a gate 403s staff mid-workflow, which is a
    // worse outcome for the business than the leak.
    expect(offenders).toEqual([]);
  });

  it("the debt list has no stale entries", () => {
    // An entry that has since been gated, deleted or renamed would silently
    // un-guard whatever replaces it. Shrinking this list is the point, so it
    // has to stay honest.
    const present = new Set(allApiRoutes());
    const gone = KNOWN_UNGATED.filter((f) => !present.has(f));
    const nowGated = KNOWN_UNGATED.filter((f) => present.has(f) && authorizes(f));
    expect({ gone, nowGated }).toEqual({ gone: [], nowGated: [] });
  });

  it("every exemption still exists", () => {
    const present = new Set(allApiRoutes());
    for (const f of Object.keys(EXEMPT)) expect(present.has(f)).toBe(true);
  });
});
