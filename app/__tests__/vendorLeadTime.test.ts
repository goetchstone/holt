// /app/__tests__/vendorLeadTime.test.ts
//
// A vendor's standard lead time and the vendor PATCH whitelist.

import { expectedArrival, MAX_LEAD_TIME_DAYS, parseLeadTimeDays } from "@/lib/vendorLeadTime";
import { parseVendorPatch } from "@/lib/vendorPatch";

describe("parseLeadTimeDays", () => {
  it("clears on empty, null or missing", () => {
    for (const raw of [null, undefined, ""]) {
      expect(parseLeadTimeDays(raw)).toEqual({ ok: true, value: null });
    }
  });

  it("takes a whole number of days, from a number or a form's string", () => {
    expect(parseLeadTimeDays(56)).toEqual({ ok: true, value: 56 });
    expect(parseLeadTimeDays(" 21 ")).toEqual({ ok: true, value: 21 });
    expect(parseLeadTimeDays(0)).toEqual({ ok: true, value: 0 });
  });

  it("refuses fractions, negatives, text and anything past a year", () => {
    for (const raw of [2.5, -1, "eight weeks", MAX_LEAD_TIME_DAYS + 1, true]) {
      expect(parseLeadTimeDays(raw).ok).toBe(false);
    }
  });
});

describe("expectedArrival", () => {
  it("is the order date plus the lead time", () => {
    const placed = new Date("2026-10-17T15:00:00Z");
    expect(expectedArrival(placed, 42)?.toISOString()).toBe("2026-11-28T15:00:00.000Z");
  });

  it("invents nothing when the lead time is not known", () => {
    expect(expectedArrival(new Date(), null)).toBeNull();
    expect(expectedArrival(new Date(), undefined)).toBeNull();
  });
});

describe("parseVendorPatch", () => {
  it("saves the contact details and lead time the edit modal shows", () => {
    const parsed = parseVendorPatch({ city: " Hickory ", phone: "", leadTimeDays: "63" });
    expect(parsed).toEqual({ ok: true, data: { city: "Hickory", phone: null, leadTimeDays: 63 } });
  });

  it("never renames a vendor, since importers find vendors by name", () => {
    const parsed = parseVendorPatch({ name: "Renamed", city: "Tupelo" });
    expect(parsed).toEqual({ ok: true, data: { city: "Tupelo" } });
  });

  it("ignores what the modal echoes back but does not own", () => {
    const parsed = parseVendorPatch({ id: 9, created: "2026-01-01", isActive: false });
    expect(parsed).toEqual({ ok: false, error: "No updatable fields in request" });
  });

  it("keeps the configurator's pricing fields working", () => {
    const parsed = parseVendorPatch({ defaultMarkup: 2.5, mapEnforced: true });
    expect(parsed).toEqual({ ok: true, data: { defaultMarkup: 2.5, mapEnforced: true } });
  });

  it("refuses a bad lead time with a message the screen can show", () => {
    expect(parseVendorPatch({ leadTimeDays: -3 })).toEqual({
      ok: false,
      error: `Lead time must be between 0 and ${MAX_LEAD_TIME_DAYS} days`,
    });
  });
});
