// /app/__tests__/ordoriteEmptyReport.test.ts

import { isSkippableEmptyReport } from "@/lib/adapters/ordorite/emptyReport";

describe("isSkippableEmptyReport", () => {
  it("skips an empty file that only triggered UndetectableDelimiter (the `\"\"\\n` case)", () => {
    // Reproduces the 2026-06-05 Temp_Purchase_Orders.csv (3 bytes: `""\n`):
    // Papa returns 0 rows + [{ code: "UndetectableDelimiter" }].
    expect(isSkippableEmptyReport(0, [{ code: "UndetectableDelimiter" }])).toBe(true);
  });

  it("skips a zero-row file with no parse errors at all", () => {
    expect(isSkippableEmptyReport(0, [])).toBe(true);
  });

  it("does NOT skip when there are data rows (even with a delimiter warning)", () => {
    expect(isSkippableEmptyReport(190, [{ code: "UndetectableDelimiter" }])).toBe(false);
    expect(isSkippableEmptyReport(5, [])).toBe(false);
  });

  it("does NOT skip a zero-row file with a real (non-delimiter) parse error", () => {
    // A genuinely malformed file must stay fatal, not be silently skipped.
    expect(isSkippableEmptyReport(0, [{ code: "TooFewFields" }])).toBe(false);
    expect(
      isSkippableEmptyReport(0, [{ code: "UndetectableDelimiter" }, { code: "TooFewFields" }]),
    ).toBe(false);
  });
});
