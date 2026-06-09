// /app/__tests__/barcode.test.ts

import { generateBarcode } from "../src/lib/barcode";

describe("generateBarcode", () => {
  it("produces SH-prefixed barcode", () => {
    const code = generateBarcode(1, 100);
    expect(code).toMatch(/^SH-1-100-[A-Z0-9]{4}$/);
  });

  it("accepts string IDs", () => {
    const code = generateBarcode("VND", "PRD");
    expect(code).toMatch(/^SH-VND-PRD-[A-Z0-9]{4}$/);
  });

  it("generates unique codes on successive calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateBarcode(1, 1)));
    // With 4-char random suffix, collisions are rare but possible; expect at least 40 unique
    expect(codes.size).toBeGreaterThan(40);
  });

  it("includes vendor and product IDs in the barcode", () => {
    const code = generateBarcode(42, 999);
    expect(code).toContain("42");
    expect(code).toContain("999");
  });
});
