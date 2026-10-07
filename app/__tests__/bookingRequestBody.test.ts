// /app/__tests__/bookingRequestBody.test.ts
//
// A-grade unit tests for lib/booking/requestBody.ts. Pure zod validation -- no
// DB, no I/O. Covers required fields, email validation, ISO->Date coercion, the
// end-after-start refinement, and optional-field passthrough so a typo in the
// schema fails red instead of letting bad input reach the create handler.

import { parseBookingInput } from "@/lib/booking/requestBody";

const valid = {
  customerName: "Jane Doe",
  customerEmail: "jane@example.com",
  startsAt: "2026-07-15T14:00:00Z",
  endsAt: "2026-07-15T14:30:00Z",
};

describe("parseBookingInput", () => {
  it("accepts a minimal valid booking and coerces dates", () => {
    const out = parseBookingInput(valid);
    expect(out.customerName).toBe("Jane Doe");
    expect(out.customerEmail).toBe("jane@example.com");
    expect(out.startsAt).toBeInstanceOf(Date);
    expect(out.endsAt).toBeInstanceOf(Date);
    expect(out.startsAt.toISOString()).toBe("2026-07-15T14:00:00.000Z");
  });

  it("requires a customer name", () => {
    expect(() => parseBookingInput({ ...valid, customerName: "" })).toThrow(/name/i);
    expect(() =>
      parseBookingInput({
        customerEmail: valid.customerEmail,
        startsAt: valid.startsAt,
        endsAt: valid.endsAt,
      }),
    ).toThrow();
  });

  it("rejects a missing or invalid email", () => {
    expect(() => parseBookingInput({ ...valid, customerEmail: "not-an-email" })).toThrow(
      /valid email/i,
    );
    expect(() =>
      parseBookingInput({
        customerName: valid.customerName,
        startsAt: valid.startsAt,
        endsAt: valid.endsAt,
      }),
    ).toThrow();
  });

  it("rejects an unparseable date", () => {
    expect(() => parseBookingInput({ ...valid, startsAt: "not-a-date" })).toThrow(/date/i);
  });

  it("rejects when endsAt is not after startsAt", () => {
    expect(() =>
      parseBookingInput({
        ...valid,
        startsAt: "2026-07-15T14:00:00Z",
        endsAt: "2026-07-15T14:00:00Z",
      }),
    ).toThrow(/after/i);
  });

  it("accepts and trims optional phone, serviceType, and notes", () => {
    const out = parseBookingInput({
      ...valid,
      customerPhone: "  555-1234  ",
      serviceType: "Consultation",
      notes: "  Looking for a sectional  ",
    });
    expect(out.customerPhone).toBe("555-1234");
    expect(out.serviceType).toBe("Consultation");
    expect(out.notes).toBe("Looking for a sectional");
  });

  it("treats omitted optional fields as undefined/null", () => {
    const out = parseBookingInput(valid);
    expect(out.customerPhone ?? null).toBeNull();
    expect(out.serviceType ?? null).toBeNull();
    expect(out.notes ?? null).toBeNull();
  });

  it("throws a plain Error with a user-facing message", () => {
    try {
      parseBookingInput({ ...valid, customerEmail: "bad" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/valid email/i);
    }
  });
});
