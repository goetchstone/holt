// /app/__tests__/salesInteractionBody.test.ts
//
// POST /api/sales/interactions validation. The undefined-vs-null split on the next
// follow-up date matters: undefined leaves a client's date alone, null clears it.

import { parseSalesInteractionBody } from "@/lib/salesInteractionBody";

describe("parseSalesInteractionBody", () => {
  it("accepts a follow-up with no note and leaves the date alone", () => {
    const parsed = parseSalesInteractionBody({ source: "PHONE", salesOrderId: 5 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      salesOrderId: 5,
      customerId: null,
      source: "PHONE",
      notes: null,
      nextFollowUpDate: undefined,
    });
  });

  it("still accepts the Pipeline Opportunity report's manager note", () => {
    const parsed = parseSalesInteractionBody({
      source: "MANAGER_NOTE",
      salesOrderId: 5,
      customerId: 9,
      notes: "Check on this one",
    });
    expect(parsed.ok).toBe(true);
  });

  it("reads a date, and reads null as clearing it", () => {
    const set = parseSalesInteractionBody({
      source: "EMAIL",
      salesOrderId: 5,
      nextFollowUpDate: "2026-12-01",
    });
    expect(set.ok && set.value.nextFollowUpDate?.toISOString()).toBe("2026-12-01T00:00:00.000Z");

    const cleared = parseSalesInteractionBody({
      source: "EMAIL",
      salesOrderId: 5,
      nextFollowUpDate: null,
    });
    expect(cleared.ok && cleared.value.nextFollowUpDate).toBeNull();
  });

  it("rejects an unknown or missing source", () => {
    expect(parseSalesInteractionBody({ source: "PIGEON" }).ok).toBe(false);
    expect(parseSalesInteractionBody({}).ok).toBe(false);
    expect(parseSalesInteractionBody(undefined).ok).toBe(false);
  });

  it("requires a note to have text, and something to attach to", () => {
    expect(parseSalesInteractionBody({ source: "NOTE", customerId: 9, notes: "   " })).toEqual({
      ok: false,
      error: "A note can't be empty.",
    });
    expect(parseSalesInteractionBody({ source: "NOTE", notes: "Summer home" })).toEqual({
      ok: false,
      error: "A note needs a client or a quote.",
    });
  });

  it("rejects a bad id or date", () => {
    expect(parseSalesInteractionBody({ source: "PHONE", salesOrderId: "5" }).ok).toBe(false);
    expect(parseSalesInteractionBody({ source: "PHONE", customerId: -1 }).ok).toBe(false);
    expect(parseSalesInteractionBody({ source: "PHONE", nextFollowUpDate: "tomorrow" }).ok).toBe(
      false,
    );
  });
});
