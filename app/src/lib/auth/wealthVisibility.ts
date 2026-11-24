// /app/src/lib/auth/wealthVisibility.ts
//
// "See wealth data" (customer.wealth): whether a caller may see customers'
// wealth data from the wealth-data import (wealth tier, net worth, lifestyle and
// life-event signals). Checked the way "View cost" is (lib/auth/costVisibility.ts):
// a screen that shows wealth beside other data is served to everyone its own
// key admits, and the wealth is left out for a caller without this one. Where
// wealth is the whole answer (the Wealth Insights report, a wealth-based list in
// Opportunities), the key is required instead.
//
// A route opts in with WITH_WEALTH on its gate (or VIEW_WEALTH in a longer
// `also` list), which answers the key from the same staff read as the gate
// itself, then asks canViewWealth(access):
//
//   async function handler(req, res, _session, access) {
//     const showWealth = canViewWealth(access);
//     ...
//     res.json({ leads, wealthVisible: showWealth });
//   }
//   export default requirePermission("sales.lead", handler, WITH_WEALTH);
//
// The response says `wealthVisible`, so the screen hides its wealth fields from
// the same answer that stripped them, rather than guessing from missing fields.

import type { CallerAccess, GateOptions } from "@/lib/auth/gateOptions";

export const VIEW_WEALTH = "customer.wealth";

/** Gate option: also answer whether the caller holds "See wealth data". */
export const WITH_WEALTH: GateOptions = { also: [VIEW_WEALTH] };

/**
 * Does the caller hold "See wealth data"? Throws when the route's gate did not
 * ask (no WITH_WEALTH): answering "no" there would quietly strip wealth from
 * everyone, holders included.
 */
export function canViewWealth(access: CallerAccess): boolean {
  if (!(VIEW_WEALTH in access.holds)) {
    throw new Error(
      "canViewWealth: this route's gate does not ask for See wealth data; pass WITH_WEALTH",
    );
  }
  return access.holds[VIEW_WEALTH];
}
