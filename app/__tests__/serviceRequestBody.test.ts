// /app/__tests__/serviceRequestBody.test.ts

import {
  parseServiceCreateInput,
  parseServiceUpdateInput,
  parseWindowCreateInput,
  parseBlockCreateInput,
} from "@/lib/booking/serviceRequestBody";

describe("parseServiceCreateInput", () => {
  it("accepts a valid service", () => {
    const out = parseServiceCreateInput({ name: "  Consult  ", durationMinutes: 60 });
    expect(out.name).toBe("Consult");
    expect(out.durationMinutes).toBe(60);
  });

  it("rejects missing name + non-positive duration", () => {
    expect(() => parseServiceCreateInput({ name: "", durationMinutes: 60 })).toThrow();
    expect(() => parseServiceCreateInput({ name: "x", durationMinutes: 0 })).toThrow(
      "greater than zero",
    );
  });
});

describe("parseServiceUpdateInput", () => {
  it("requires at least one field", () => {
    expect(() => parseServiceUpdateInput({})).toThrow("Nothing to update");
    expect(parseServiceUpdateInput({ isActive: false })).toEqual({ isActive: false });
  });
});

describe("parseWindowCreateInput", () => {
  it("accepts a valid window", () => {
    expect(
      parseWindowCreateInput({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" }),
    ).toMatchObject({ dayOfWeek: 1, startTime: "09:00", endTime: "17:00" });
  });

  it("rejects bad times + end before start", () => {
    expect(() =>
      parseWindowCreateInput({ dayOfWeek: 1, startTime: "9", endTime: "17:00" }),
    ).toThrow();
    expect(() =>
      parseWindowCreateInput({ dayOfWeek: 1, startTime: "17:00", endTime: "09:00" }),
    ).toThrow("after the start");
  });
});

describe("parseBlockCreateInput", () => {
  it("accepts a valid block and coerces dates", () => {
    const out = parseBlockCreateInput({
      startsAt: "2026-06-01T09:00:00Z",
      endsAt: "2026-06-01T17:00:00Z",
      reason: "Closed",
    });
    expect(out.startsAt).toBeInstanceOf(Date);
    expect(out.reason).toBe("Closed");
  });

  it("rejects end before start", () => {
    expect(() =>
      parseBlockCreateInput({ startsAt: "2026-06-02T00:00:00Z", endsAt: "2026-06-01T00:00:00Z" }),
    ).toThrow("after the start");
  });
});
