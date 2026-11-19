// /app/src/lib/reports/salespersonScope.ts
//
// Which salesperson a caller may ask for on the salesperson reports (Monthly
// Performance, Salesperson Detail, Designer Dashboard). One decision, shared by
// all three procedures (CLAUDE.md rules 14 and 42), and a store setting: it
// follows the "See every salesperson's numbers" permission, not a role name.

import type { GateOptions } from "@/lib/auth/gateOptions";

export const ALL_SALESPEOPLE = "reporting.all-salespeople";

/** Gate option: also answer whether the caller may see every salesperson. */
export const WITH_ALL_SALESPEOPLE: GateOptions = { also: [ALL_SALESPEOPLE] };

/**
 * The salesperson to report on, or "" when there is none.
 *
 * A holder gets what they asked for (empty means the caller supplies nothing,
 * which the procedure rejects). Anyone else is always their own record from the
 * session, whatever they sent: the input is never trusted for them.
 */
export function salespersonForCaller(args: {
  seesEveryone: boolean;
  requested: string | null | undefined;
  selfDisplayName: string | null | undefined;
}): string {
  return args.seesEveryone ? (args.requested ?? "") : (args.selfDisplayName ?? "");
}

/** Does the gate's `holds` say this caller may see every salesperson? Throws
 *  when the gate did not ask: answering "no" would silently scope holders. */
export function canSeeAllSalespeople(access: {
  holds: Readonly<Record<string, boolean>>;
}): boolean {
  if (!(ALL_SALESPEOPLE in access.holds)) {
    throw new Error(
      "canSeeAllSalespeople: this procedure's gate does not ask for it; pass WITH_ALL_SALESPEOPLE",
    );
  }
  return access.holds[ALL_SALESPEOPLE];
}
