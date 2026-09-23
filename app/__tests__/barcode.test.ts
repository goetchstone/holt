// /app/__tests__/barcode.test.ts

import { generateBarcode } from "../src/lib/barcode";

describe("generateBarcode", () => {
  it("starts with the business's prefix", () => {
    const code = generateBarcode("HR", 1, 100);
    expect(code).toMatch(/^HR-1-100-[A-Z0-9]{4}$/);
  });

  it("accepts string IDs", () => {
    const code = generateBarcode("ABC123", "VND", "PRD");
    expect(code).toMatch(/^ABC123-VND-PRD-[A-Z0-9]{4}$/);
  });

  it("generates unique codes on successive calls", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateBarcode("HR", 1, 1)));
    // With 4-char random suffix, collisions are rare but possible; expect at least 40 unique
    expect(codes.size).toBeGreaterThan(40);
  });

  it("includes vendor and product IDs in the barcode", () => {
    const code = generateBarcode("HR", 42, 999);
    expect(code).toContain("42");
    expect(code).toContain("999");
  });
});
