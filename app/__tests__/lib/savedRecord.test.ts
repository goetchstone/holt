// /app/__tests__/lib/savedRecord.test.ts
//
// A list's "Add New" opens its form with {}; five forms took that for an edit
// and saved new records to /api/<things>/undefined (lib/savedRecord.ts).

import { isSavedRecord } from "@/lib/savedRecord";

describe("isSavedRecord", () => {
  it("is an edit only when the record has an id", () => {
    expect(isSavedRecord({ id: 7, name: "Sofas" })).toBe(true);
    expect(isSavedRecord({})).toBe(false);
    expect(isSavedRecord({ id: null })).toBe(false);
    expect(isSavedRecord(null)).toBe(false);
    expect(isSavedRecord(undefined)).toBe(false);
  });
});
