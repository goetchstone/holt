// /app/src/lib/vendorLeadTime.ts
//
// A vendor's standard lead time, and the date it puts on a PO.
//
// Lead time is a fact about the vendor (Vendor.leadTimeDays), entered once on
// the vendor screen. A native special-order PO raised at the register used to
// carry no expected date at all, so nothing could tell a buyer which open
// orders were late. It now takes order date + lead time.
//
// Unknown stays unknown. With no lead time recorded the expected date is null,
// which the Delivery Planner shows as "No ESD" -- the row a buyer chases. A
// default guess here would put a confident, invented date on every PO raised
// against a vendor nobody has set up yet.

/** A year. Furniture lead times run from days to a few months; anything past a
 *  year is a typo (weeks or months entered as days). */
export const MAX_LEAD_TIME_DAYS = 365;

const DAY_MS = 86_400_000;

export type LeadTimeParse = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Read a lead time from a request body. Empty, null and "" clear it; anything
 * else must be a whole number of days from 0 to MAX_LEAD_TIME_DAYS.
 */
export function parseLeadTimeDays(raw: unknown): LeadTimeParse {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    return { ok: false, error: "Lead time must be a whole number of days" };
  }
  if (n < 0 || n > MAX_LEAD_TIME_DAYS) {
    return { ok: false, error: `Lead time must be between 0 and ${MAX_LEAD_TIME_DAYS} days` };
  }
  return { ok: true, value: n };
}

/** When goods ordered on `orderDate` are due, or null when the vendor's lead
 *  time is not known. */
export function expectedArrival(
  orderDate: Date,
  leadTimeDays: number | null | undefined,
): Date | null {
  if (leadTimeDays == null) return null;
  return new Date(orderDate.getTime() + leadTimeDays * DAY_MS);
}
