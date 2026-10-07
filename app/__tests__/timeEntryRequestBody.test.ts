// /app/__tests__/timeEntryRequestBody.test.ts

import {
  parseTimeEntryCreateInput,
  parseTimeEntryUpdateInput,
} from "@/lib/timeEntries/requestBody";

describe("parseTimeEntryCreateInput", () => {
  it("accepts a valid entry and coerces the date", () => {
    const out = parseTimeEntryCreateInput({
      description: "  Design review  ",
      minutes: 90,
      date: "2026-06-03",
    });
    expect(out.description).toBe("Design review");
    expect(out.minutes).toBe(90);
    expect(out.date).toBeInstanceOf(Date);
  });

  it("rejects missing description, zero minutes, and a bad date", () => {
    expect(() =>
      parseTimeEntryCreateInput({ description: "", minutes: 60, date: "2026-06-03" }),
    ).toThrow();
    expect(() =>
      parseTimeEntryCreateInput({ description: "x", minutes: 0, date: "2026-06-03" }),
    ).toThrow("greater than zero");
    expect(() =>
      parseTimeEntryCreateInput({ description: "x", minutes: 60, date: "nope" }),
    ).toThrow("Invalid date");
  });
});

describe("parseTimeEntryUpdateInput", () => {
  it("accepts a single field", () => {
    expect(parseTimeEntryUpdateInput({ billed: true })).toEqual({ billed: true });
    expect(parseTimeEntryUpdateInput({ minutes: 30 })).toEqual({ minutes: 30 });
  });

  it("rejects an empty update", () => {
    expect(() => parseTimeEntryUpdateInput({})).toThrow("Nothing to update");
  });
});
