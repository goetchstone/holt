// /app/src/lib/auth/commissionPay.ts
//
// "See and run commission and pay" (staff.commission-pay): the owner-tier key
// behind the Commission and Pay Period Sales screens and the APIs under them.
// The screens gate on the key directly. This file is for the one place the key
// is not the whole gate: Admin > Staff admits `staff.manage`, shows the
// commission-plan pickers only to a holder, and refuses a plan CHANGE from
// anyone else (the write needs the key as much as the read does, rule 42).

import type { CallerAccess, GateOptions } from "@/lib/auth/gateOptions";

export const COMMISSION_PAY = "staff.commission-pay";

/** Gate option: also answer whether the caller holds the key. */
export const WITH_COMMISSION_PAY: GateOptions = { also: [COMMISSION_PAY] };

export const COMMISSION_PLAN_REFUSED =
  "Changing a commission plan needs the 'See and run commission and pay' permission.";

/** Does the caller hold the key? Throws when the gate did not ask for it, as
 *  canViewCost does, so a missing option cannot quietly refuse every holder. */
export function canSeeCommissionPay(access: CallerAccess): boolean {
  if (!(COMMISSION_PAY in access.holds)) {
    throw new Error(
      "canSeeCommissionPay: this gate does not ask for the key; pass WITH_COMMISSION_PAY",
    );
  }
  return access.holds[COMMISSION_PAY];
}

/** Would saving `requested` change a staff member's plan? Absent, or naming the
 *  plan they already have, changes nothing, so an ordinary edit is never refused. */
export function changesCommissionPlan(
  requested: number | null | undefined,
  current: number | null,
): boolean {
  return requested !== undefined && requested !== current;
}
