// /app/src/lib/reports/salespersonScope.ts
//
// Which salesperson a caller may ask for on the salesperson reports (Monthly
// Performance, Salesperson Detail, Designer Dashboard and Sales by
// Salesperson). One decision per report family, shared by every procedure,
// route and page that serves it (CLAUDE.md rules 14 and 42), and a store
// setting: it follows permissions, not a role name or the session token.
//
// The three single-salesperson reports follow "See every salesperson's
// numbers" (reporting.all-salespeople). Sales by Salesperson follows that key
// or "See customer lists" (marketing.lists): its old role list let Marketing
// choose anyone there, and only there, so Marketing keeps it on that report
// without gaining the other three (role-list sweep, 2026-11-21).

import type { GateOptions } from "@/lib/auth/gateOptions";

export const ALL_SALESPEOPLE = "reporting.all-salespeople";

/** Gate option: also answer whether the caller may see every salesperson. */
export const WITH_ALL_SALESPEOPLE: GateOptions = { also: [ALL_SALESPEOPLE] };

/** The keys, any one of which lets a caller see every salesperson on Sales by
 *  Salesperson (the screen, its drill-down and its CSV export). */
export const SALES_BY_SALESPERSON_EVERYONE = [ALL_SALESPEOPLE, "marketing.lists"] as const;

/** Gate option for Sales by Salesperson: also answer both of those keys. */
export const WITH_SALES_BY_SALESPERSON_EVERYONE: GateOptions = {
  also: SALES_BY_SALESPERSON_EVERYONE,
};

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

/** May this caller see every salesperson on Sales by Salesperson? Throws when
 *  the gate did not ask for both keys: answering "no" for a key nobody asked
 *  about would silently scope its holders to their own numbers. */
export function salesBySalespersonSeesEveryone(access: {
  holds: Readonly<Record<string, boolean>>;
}): boolean {
  if (SALES_BY_SALESPERSON_EVERYONE.some((key) => !(key in access.holds))) {
    throw new Error(
      "salesBySalespersonSeesEveryone: this gate does not ask for both keys; pass WITH_SALES_BY_SALESPERSON_EVERYONE",
    );
  }
  return SALES_BY_SALESPERSON_EVERYONE.some((key) => access.holds[key]);
}
