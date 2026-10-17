// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/tabs.ts
//
// The Commission screen's tabs, in their own plain module: the server page reads
// `?tab=` against this list, and a value exported from the "use client" view
// reaches a server component only as a client reference, not as the array.

export type CommissionTab = "drafts" | "locked" | "calculator";

export const COMMISSION_TABS: readonly CommissionTab[] = ["drafts", "locked", "calculator"];

/** The tab `?tab=` names, or undefined for anything else. */
export function commissionTabFrom(raw: string | string[] | undefined): CommissionTab | undefined {
  return COMMISSION_TABS.find((t) => t === raw);
}
