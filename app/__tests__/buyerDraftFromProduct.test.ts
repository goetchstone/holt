// /app/__tests__/buyerDraftFromProduct.test.ts
//
// A-grade tests for the Product → BuyerDraftItem-create-body helper.

import { buildDraftBodyFromProduct, type ProductForDraft } from "@/lib/buyerDraftFromProduct";

const baseProduct: ProductForDraft = {
  id: 12345,
  productNumber: "L2272-05SW",
  name: "Murphey Swivel Chair",
  vendorId: 7,
  vendor: { name: "CR Laine" },
  departmentId: 3,
  categoryId: 11,
  typeId: 42,
  baseCost: { toString: () => "1275.00" },
  baseRetail: { toString: () => "3039.00" },
  mapPrice: { toString: () => "4050.00" },
  width: 30,
  depth: 39.5,
  height: 34,
};

describe("buildDraftBodyFromProduct", () => {
  it("copies identity + pricing + FK ids 1:1", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(body.vendorId).toBe(7);
    expect(body.vendorName).toBe("CR Laine");
    expect(body.partNumber).toBe("L2272-05SW");
    expect(body.productName).toBe("Murphey Swivel Chair");
    expect(body.cost).toBe("1275.00");
    expect(body.retail).toBe("3039.00");
    expect(body.msrp).toBe("4050.00");
    expect(body.departmentId).toBe(3);
    expect(body.categoryId).toBe(11);
    expect(body.typeId).toBe(42);
  });

  it("stringifies dimensions (Decimal-via-toString-passthrough)", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(body.productWidth).toBe("30");
    expect(body.productLength).toBe("39.5"); // depth → length per buyer's mental model
    expect(body.productHeight).toBe("34");
  });

  it("emits 0 cost/retail when the Product has neither baseCost nor baseRetail", () => {
    const p: ProductForDraft = {
      ...baseProduct,
      baseCost: null,
      baseRetail: null,
    };
    const body = buildDraftBodyFromProduct(p);
    expect(body.cost).toBe("0");
    expect(body.retail).toBe("0");
  });

  it("emits null msrp when the Product has no mapPrice", () => {
    const p: ProductForDraft = { ...baseProduct, mapPrice: null };
    expect(buildDraftBodyFromProduct(p).msrp).toBeNull();
  });

  it("emits null dimensions when the Product has none", () => {
    const p: ProductForDraft = {
      ...baseProduct,
      width: null,
      depth: null,
      height: null,
    };
    const body = buildDraftBodyFromProduct(p);
    expect(body.productWidth).toBeNull();
    expect(body.productLength).toBeNull();
    expect(body.productHeight).toBeNull();
  });

  it("passes through null typeId (Type is optional on Product)", () => {
    const p: ProductForDraft = { ...baseProduct, typeId: null };
    expect(buildDraftBodyFromProduct(p).typeId).toBeNull();
  });

  it("always tags source as MANUAL (catalog re-order is buyer-driven)", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(body.source).toBe("MANUAL");
  });

  it("references the source Product id in the notes for audit trail", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(body.notes).toBe("Re-ordered from existing catalog: Product #12345");
  });

  // ── Slice 6.1 (2026-05-12) — link-at-create ──────────────────────────
  // The buyer scanned a barcode that resolved to this Product — that IS
  // the link. Setting `fulfilledProductId` + `fulfilledAt` here means the
  // Slice 6 performance report and the Slice 6.1 display fallback see
  // the connection immediately, without waiting for the Slice 5 auto-link
  // sweep (which won't fire because the Product already exists in the
  // catalog with its UPC).

  it("sets fulfilledProductId to the source Product id", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(body.fulfilledProductId).toBe(12345);
  });

  it("stamps fulfilledAt with a parseable ISO timestamp", () => {
    const body = buildDraftBodyFromProduct(baseProduct);
    expect(typeof body.fulfilledAt).toBe("string");
    const parsed = new Date(body.fulfilledAt);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Stamped now-ish — within the last 5 seconds.
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });
});
