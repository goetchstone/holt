// /app/e2e/knownFailures.ts
//
// Pages the smoke suite has found broken and that are not fixed yet: a ratchet
// (CLAUDE.md rule 65). pages.spec.ts marks each one `test.fail`, so the run
// stays green while it fails for the listed reason, and goes red the moment it
// passes: a fixed page must leave this list in the same PR as its fix.
// __tests__/e2eDynamicRoutes.test.ts checks every entry names a real route and
// says why. Each reason names where the fix is tracked, and each entry names
// the account it fails for: a page can be broken for the Administrator and fine
// for the Owner.

import type { SignInName } from "./signIn";

export interface KnownFailure {
  as: SignInName;
  reason: string;
}

// Empty since the 2026-11 role-list sweep: the receiving-gaps and leads pages
// failed for the Owner because a data API behind each checked the staff enum
// for MANAGER or ADMIN by name, and both APIs now take permission keys.
export const KNOWN_FAILURES: Record<string, KnownFailure> = {};
