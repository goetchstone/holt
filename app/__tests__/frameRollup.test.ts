// /app/__tests__/frameRollup.test.ts

import {
  stripLastSegment,
  classifyVendors,
  buildFrameDecisions,
  MIN_CONFIGS_PER_ROOT,
  MIN_PRODUCTS_FOR_CLASSIFICATION,
  type FrameInput,
} from "@/lib/frameRollup";

describe("stripLastSegment", () => {
  it("strips a single trailing segment", () => {
    expect(stripLastSegment("SE-F21-XLS")).toBe("SE-F21");
  });

  it("strips only the last segment, not multiple", () => {
    expect(stripLastSegment("WH-SE-F21-XLS")).toBe("WH-SE-F21");
  });

  it("returns the SKU unchanged when there is no hyphen", () => {
    expect(stripLastSegment("ABC123")).toBe("ABC123");
  });

  it("returns the SKU unchanged when the only hyphen is at the start", () => {
    expect(stripLastSegment("-SUFFIX")).toBe("-SUFFIX");
  });

  it("handles single-letter grade suffixes", () => {
    expect(stripLastSegment("L0123-D")).toBe("L0123");
  });
});

describe("classifyVendors", () => {
  function sku(productId: number, productNumber: string, vendorId: number): FrameInput {
    return { productId, productNumber, vendorId };
  }

  it("classifies a clearly configurable vendor as configurable", () => {
    // Wesley Hall: WH- vendor prefix, SE-F21-XLS vendorSku with substructure
    const inputs: FrameInput[] = [
      sku(1, "WH-SE-F21-XLS", 100),
      sku(2, "WH-SE-F21-LS", 100),
      sku(3, "WH-SE-F21-S", 100),
      sku(4, "WH-SE-F22-XLS", 100),
      sku(5, "WH-SE-F22-LS", 100),
      sku(6, "WH-SE-F22-S", 100),
      sku(7, "WH-SE-F23-XLS", 100),
    ];
    // After stripping WH- : SE-F21-XLS etc. 3 roots -> 2.33 configs/root
    const result = classifyVendors(inputs);
    expect(result.has(100)).toBe(true);
  });

  it("classifies a flat-SKU vendor (single-segment vendorSku) as not configurable", () => {
    // Uttermost-style: <vendorPrefix>-<numericId>, no further substructure
    const inputs: FrameInput[] = Array.from({ length: 10 }, (_, i) => sku(i, `UTT-1000${i}`, 200));
    // Vendor SKUs after prefix-strip: 10000, 10001, ... -- no hyphens -> flat
    const result = classifyVendors(inputs);
    expect(result.has(200)).toBe(false);
  });

  it("skips vendors below the minimum product count (too noisy)", () => {
    // Vendor with only 3 products, all configurable -- but count too low
    const inputs: FrameInput[] = [
      sku(1, "X-F1-A", 300),
      sku(2, "X-F1-B", 300),
      sku(3, "X-F1-C", 300),
    ];
    expect(inputs.length).toBeLessThan(MIN_PRODUCTS_FOR_CLASSIFICATION);
    const result = classifyVendors(inputs);
    expect(result.has(300)).toBe(false);
  });

  it("handles vendors with missing product numbers (ignores those)", () => {
    const inputs: FrameInput[] = [
      sku(1, "WH-SE-F21-XLS", 100),
      sku(2, "WH-SE-F21-LS", 100),
      sku(3, "WH-SE-F21-S", 100),
      sku(4, "WH-SE-F22-XLS", 100),
      sku(5, "WH-SE-F22-LS", 100),
      { productId: 6, productNumber: null, vendorId: 100 },
    ];
    const result = classifyVendors(inputs);
    expect(result.has(100)).toBe(true);
  });

  it("threshold is exclusive below 1.5", () => {
    // Mixed: 6 SKUs across 5 roots -> 1.2, should NOT classify
    const inputs: FrameInput[] = [
      sku(1, "V-A-1", 400),
      sku(2, "V-A-2", 400),
      sku(3, "V-B-1", 400),
      sku(4, "V-C-1", 400),
      sku(5, "V-D-1", 400),
      sku(6, "V-E-1", 400),
    ];
    expect(6 / 5).toBeLessThan(MIN_CONFIGS_PER_ROOT);
    const result = classifyVendors(inputs);
    expect(result.has(400)).toBe(false);
  });

  it("skips a vendor whose vendor-SKU portions are all single-segment", () => {
    // Every Uttermost-style vendor: numeric IDs after prefix, no substructure
    const inputs: FrameInput[] = Array.from({ length: 20 }, (_, i) =>
      sku(i, `UTT-${10000 + i}`, 500),
    );
    const result = classifyVendors(inputs);
    expect(result.has(500)).toBe(false);
  });
});

describe("buildFrameDecisions", () => {
  function sku(productId: number, productNumber: string, vendorId: number): FrameInput {
    return { productId, productNumber, vendorId };
  }

  it("passes through each SKU when rollup is disabled", () => {
    const inputs: FrameInput[] = [sku(1, "WH-SE-F21-XLS", 100), sku(2, "WH-SE-F21-LS", 100)];
    const result = buildFrameDecisions(inputs, false);
    expect(result.size).toBe(2);
    expect(result.get(1)?.frameKey).toBe("100:WH-SE-F21-XLS");
    expect(result.get(1)?.collapsed).toBe(false);
    expect(result.get(2)?.frameKey).toBe("100:WH-SE-F21-LS");
  });

  it("collapses configurable vendor SKUs when enabled", () => {
    const inputs: FrameInput[] = [
      sku(1, "WH-SE-F21-XLS", 100),
      sku(2, "WH-SE-F21-LS", 100),
      sku(3, "WH-SE-F21-S", 100),
      sku(4, "WH-SE-F22-XLS", 100),
      sku(5, "WH-SE-F22-LS", 100),
    ];
    const result = buildFrameDecisions(inputs, true);
    expect(result.get(1)?.frameKey).toBe(result.get(2)?.frameKey);
    expect(result.get(1)?.frameKey).toBe(result.get(3)?.frameKey);
    expect(result.get(1)?.frameKey).not.toBe(result.get(4)?.frameKey);
    expect(result.get(1)?.collapsed).toBe(true);
    expect(result.get(1)?.frameLabel).toBe("WH-SE-F21");
  });

  it("keeps flat-SKU vendor products distinct when enabled", () => {
    const inputs: FrameInput[] = Array.from({ length: 10 }, (_, i) => sku(i, `UTT-1000${i}`, 200));
    const result = buildFrameDecisions(inputs, true);
    const keys = new Set([...result.values()].map((v) => v.frameKey));
    expect(keys.size).toBe(10); // no collapsing
    expect([...result.values()].every((v) => !v.collapsed)).toBe(true);
    // Labels stay as the full SKU for flat vendors
    expect(result.get(0)?.frameLabel).toBe("UTT-10000");
  });

  it("frame keys are vendor-scoped so two vendors with same root don't collide", () => {
    // Both vendors need 5+ configurable products to classify
    const inputs: FrameInput[] = [
      sku(1, "WH-F21-A", 100),
      sku(2, "WH-F21-B", 100),
      sku(3, "WH-F21-C", 100),
      sku(4, "WH-F22-A", 100),
      sku(5, "WH-F22-B", 100),
      sku(6, "CRL-F21-A", 200),
      sku(7, "CRL-F21-B", 200),
      sku(8, "CRL-F21-C", 200),
      sku(9, "CRL-F22-A", 200),
      sku(10, "CRL-F22-B", 200),
    ];
    const result = buildFrameDecisions(inputs, true);
    // Both have a "F21" frame but different vendors -> different keys
    expect(result.get(1)?.frameKey).not.toBe(result.get(6)?.frameKey);
    // Different labels too since we preserve vendor prefix: WH-F21 vs CRL-F21
    expect(result.get(1)?.frameLabel).toBe("WH-F21");
    expect(result.get(6)?.frameLabel).toBe("CRL-F21");
  });

  it("preserves full SKU as label when the vendor is classified but the sku has no substructure after prefix", () => {
    // Vendor is classified as configurable (via other SKUs), but this one
    // product has just `VEN-42` with no substructure. Should not break.
    const inputs: FrameInput[] = [
      sku(1, "VEN-F1-A", 300),
      sku(2, "VEN-F1-B", 300),
      sku(3, "VEN-F1-C", 300),
      sku(4, "VEN-F2-A", 300),
      sku(5, "VEN-F2-B", 300),
      sku(6, "VEN-42", 300), // single-segment vendorSku
    ];
    const result = buildFrameDecisions(inputs, true);
    // sku 6's vendorSku is "42", no hyphen -> stripLastSegment returns
    // "42" unchanged -> collapsed=false, label preserves prefix form
    expect(result.get(6)?.collapsed).toBe(false);
  });
});
