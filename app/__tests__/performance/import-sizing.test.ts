// /app/__tests__/performance/import-sizing.test.ts
//
// Performance sizing tests for the import pipeline.
// These test payload generation and schema validation overhead only.
// Full database integration tests require a running PostgreSQL instance.
//
// Run with: npx jest --selectProjects integration
// Or: npm run test:integration

import { wholesaleImportSchema } from "@/lib/validation/schemas";

function generateWholesalePayload(productCount: number) {
  const products = Array.from({ length: productCount }, (_, i) => ({
    styleNumber: `PERF-${String(i + 1).padStart(4, "0")}`,
    description: `Performance Test Product ${i + 1}`,
    styleName: `Test Style ${i + 1}`,
    gradePrices: [
      { grade: "COM", cost: 1000 + i },
      { grade: "14", cost: 1100 + i },
      { grade: "15", cost: 1200 + i },
      { grade: "16", cost: 1300 + i },
      { grade: "17", cost: 1400 + i },
    ],
    gradeRiser: 25,
    yardagePlain: 8.5,
    overallWidth: 84,
    overallDepth: 38,
    overallHeight: 36,
  }));

  return {
    vendorId: 1,
    priceListName: `Performance Test (${productCount} products)`,
    effectiveDate: "2026-01-01",
    products,
  };
}

describe("Import payload sizing", () => {
  it.each([100, 500, 1000, 2000])("validates a %d-product wholesale payload", (count) => {
    const payload = generateWholesalePayload(count);
    const start = Date.now();
    const result = wholesaleImportSchema.safeParse(payload);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);

    // Log sizing info for documentation
    const jsonSize = JSON.stringify(payload).length;
    const sizeKB = (jsonSize / 1024).toFixed(1);
    const sizeMB = (jsonSize / (1024 * 1024)).toFixed(2);

    // eslint-disable-next-line no-console
    console.log(`  ${count} products: ${sizeKB}KB (${sizeMB}MB) JSON, validated in ${elapsed}ms`);

    // Validation should be fast even for large payloads
    expect(elapsed).toBeLessThan(5000);

    // Payloads should be well under the 20MB body parser limit
    expect(jsonSize).toBeLessThan(20 * 1024 * 1024);
  });

  it("reports the 20MB body parser limit boundary", () => {
    // At ~0.2KB per product (5 grades, dimensions), the theoretical limit is
    // roughly 100,000 products before hitting 20MB. Real-world price books
    // are typically 200-800 products, well within limits.
    const payload = generateWholesalePayload(2000);
    const jsonSize = JSON.stringify(payload).length;
    const maxProducts = Math.floor((20 * 1024 * 1024) / (jsonSize / 2000));

    // eslint-disable-next-line no-console
    console.log(`  Estimated max products before 20MB limit: ~${maxProducts.toLocaleString()}`);

    expect(maxProducts).toBeGreaterThan(10000);
  });
});
