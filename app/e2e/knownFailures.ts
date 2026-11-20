// /app/e2e/knownFailures.ts
//
// Pages the smoke suite has found broken and that are not fixed yet: a ratchet
// (CLAUDE.md rule 65). pages.spec.ts marks each one `test.fail`, so the run
// stays green while it fails for the listed reason, and goes red the moment it
// passes: a fixed page must leave this list in the same PR as its fix.
// __tests__/e2eDynamicRoutes.test.ts checks every entry names a real route and
// says why. Each reason names where the fix is tracked.

/** Why each of these fails, once. */
const OWNER_ONLY_APIS =
  "an Administrator can open the screen (its page gate is a permission) but its commission or pay data API is hardcoded SUPER_ADMIN-only (requireAuthWithRole / roleProcedure), so every data call 403s; fix tracked in the local roadmap, Health audit 2026-11-18";

export const KNOWN_FAILURES: Record<string, string> = {
  "/app/admin/reports/commission-tiers": OWNER_ONLY_APIS,
  "/app/admin/staff": OWNER_ONLY_APIS,
  "/app/reports/commission": OWNER_ONLY_APIS,
  "/app/reports/pay-period-sales": OWNER_ONLY_APIS,
};
