// /app/src/lib/auth/gateOptions.ts
//
// What every gate (requirePermission, requireAuthWithRole, permissionProcedure,
// requirePage) accepts beyond its own requirement, and what it tells the code
// behind it. Kept apart from requireAuth.ts so the tRPC and App Router gates
// can use it without importing the Pages Router's NextAuth configuration.

import { isPermissionKey } from "@/lib/auth/permissionCatalog";

/** Options for a gated route, procedure or page. */
export interface GateOptions {
  /**
   * Permission keys to answer for the caller beside the gate itself, without
   * requiring them. The handler gets the answers as `access.holds`, decided
   * from the same staff read as the gate. For a route that serves two
   * audiences, e.g. `WITH_COST` (lib/auth/costVisibility.ts) strips cost for a
   * caller without "View cost" instead of refusing them.
   */
  readonly also?: readonly string[];
}

/** What gated code learns about its caller, beyond the session. */
export interface CallerAccess {
  /** For each key in the gate's `also`: does the caller hold it? */
  readonly holds: Readonly<Record<string, boolean>>;
}

/** A key in `also` that is not in the catalog is a typo in code: refused when
 *  the gate is built (route or procedure load), not quietly answered "no" on
 *  every request. */
export function assertKnownKeys(gate: string, also: readonly string[] | undefined): void {
  for (const key of also ?? []) {
    if (!isPermissionKey(key)) {
      throw new Error(`${gate}: "${key}" in { also } is not a permission key`);
    }
  }
}
