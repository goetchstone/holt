// /app/__tests__/homeAccessoryBuyerDraftMapping.test.ts
//
// Pins the Home Accessory Order Import tool's KEY adaptation from FC: how
// composed EffectiveRows become BuyerDraftPurchaseOrder / BuyerDraftItem
// create payloads, instead of Ordorite CSV rows. Pure — no Prisma, no I/O
// (the commit API route hydrates + writes; these functions only shape the
// payloads it hands to buildPoCreateData / buildItemCreateData).

import {
  groupRowsByReference,
  unassignedRows,
  buildHomeAccessoryPoCreateBody,
  buildHomeAccessoryItemCreateBody,
  poReconciliationTotal,
  composedTotal,
  unclassifiedRowCount,
  type HomeAccessoryCommitContext,
} from "@/lib/homeAccessoryBuyerDraftMapping";
import type { EffectiveRow } from "@/lib/homeAccessoryRows";

function effectiveRow(overrides: Partial<EffectiveRow> = {}): EffectiveRow {
  return {
    key: "0",
    rowIndex: 0,
    setSize: null,
    isSplitChild: false,
    poExcluded: false,
    departmentId: 1,
    categoryId: 10,
    partNumber: "KKI-15668B",
    styleNumber: "15668B",
    productName: "13.5 Inch Brown Resin Horse",
    color: "",
    size: "",
    qty: 4,
    cost: 39.99,
    msrp: null,
    selling: null,
    department: "Home Acc",
    category: "Decor",
    supplier: "K & K Interiors",
    barcode: "842657186221",
    reference: "0002592360",
    ...overrides,
  };
}

function ctx(overrides: Partial<HomeAccessoryCommitContext> = {}): HomeAccessoryCommitContext {
  return {
    vendorId: 7,
    vendorName: "K & K Interiors",
    stockLocationId: 3,
    buyId: null,
    sourceLabel: "Home Accessory Order Import — K & K Interiors",
    ...overrides,
  };
}

describe("groupRowsByReference — multi-PO bundles", () => {
  it("groups rows sharing a reference into one PO group", () => {
    const rows = [
      effectiveRow({ key: "0", reference: "A" }),
      effectiveRow({ key: "1", reference: "A" }),
      effectiveRow({ key: "2", reference: "B" }),
    ];
    const groups = groupRowsByReference(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ reference: "A" });
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1]).toMatchObject({ reference: "B" });
    expect(groups[1].rows).toHaveLength(1);
  });

  it("a K&K-style two-order bundle creates two groups, not one merged group", () => {
    const rows = [
      effectiveRow({ key: "0", reference: "0002592360" }),
      effectiveRow({ key: "1", reference: "0002592361" }),
    ];
    expect(groupRowsByReference(rows).map((g) => g.reference)).toEqual([
      "0002592360",
      "0002592361",
    ]);
  });

  it("preserves first-appearance order across groups", () => {
    const rows = [
      effectiveRow({ key: "0", reference: "B" }),
      effectiveRow({ key: "1", reference: "A" }),
      effectiveRow({ key: "2", reference: "B" }),
    ];
    expect(groupRowsByReference(rows).map((g) => g.reference)).toEqual(["B", "A"]);
  });

  it("excludes rows the buyer took off the PO", () => {
    const rows = [
      effectiveRow({ key: "0", reference: "A", poExcluded: false }),
      effectiveRow({ key: "1", reference: "A", poExcluded: true }),
    ];
    const groups = groupRowsByReference(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].key).toBe("0");
  });

  it("excludes rows with a blank reference", () => {
    const rows = [
      effectiveRow({ key: "0", reference: "" }),
      effectiveRow({ key: "1", reference: "   " }),
    ];
    expect(groupRowsByReference(rows)).toEqual([]);
  });
});

describe("unassignedRows", () => {
  it("returns poExcluded rows and blank-reference rows, nothing else", () => {
    const onPo = effectiveRow({ key: "0", reference: "A", poExcluded: false });
    const offPo = effectiveRow({ key: "1", reference: "A", poExcluded: true });
    const blank = effectiveRow({ key: "2", reference: "", poExcluded: false });
    const rows = [onPo, offPo, blank];
    expect(unassignedRows(rows).map((r) => r.key)).toEqual(["1", "2"]);
  });

  it("returns [] when every row is assigned", () => {
    const rows = [effectiveRow({ key: "0" }), effectiveRow({ key: "1", reference: "B" })];
    expect(unassignedRows(rows)).toEqual([]);
  });
});

describe("buildHomeAccessoryPoCreateBody", () => {
  it("maps the group's reference to referenceNumber and carries vendor + buy context", () => {
    const group = { reference: "0002592360", rows: [effectiveRow()] };
    const body = buildHomeAccessoryPoCreateBody(group, ctx({ buyId: 42 }));
    expect(body).toMatchObject({
      vendorId: 7,
      vendorName: "K & K Interiors",
      referenceNumber: "0002592360",
      buyId: 42,
    });
    expect(body.notes).toContain("0002592360");
  });

  it("looks up expectedShipMonth from the context's per-reference date map", () => {
    const group = { reference: "0002592360", rows: [effectiveRow()] };
    const body = buildHomeAccessoryPoCreateBody(
      group,
      ctx({ requiredDateByReference: { "0002592360": "8/1/26" } }),
    );
    expect(body.expectedShipMonth).toBe("8/1/26");
  });

  it("falls through to null when the reference has no mapped date", () => {
    const group = { reference: "0002592360", rows: [effectiveRow()] };
    const body = buildHomeAccessoryPoCreateBody(group, ctx());
    expect(body.expectedShipMonth).toBeNull();
  });

  it("carries a null vendorId through when the supplier doesn't match a catalog Vendor", () => {
    const group = { reference: "REF1", rows: [effectiveRow()] };
    const body = buildHomeAccessoryPoCreateBody(group, ctx({ vendorId: null }));
    expect(body.vendorId).toBeNull();
    expect(body.vendorName).toBe("K & K Interiors");
  });
});

describe("buildHomeAccessoryItemCreateBody", () => {
  it("maps the core fields straight across", () => {
    const row = effectiveRow();
    const body = buildHomeAccessoryItemCreateBody(row, 99, ctx());
    expect(body).toMatchObject({
      vendorId: 7,
      vendorName: "K & K Interiors",
      partNumber: "KKI-15668B",
      productName: "13.5 Inch Brown Resin Horse",
      cost: 39.99,
      qty: 4,
      barcode: "842657186221",
      departmentId: 1,
      categoryId: 10,
      draftPoId: 99,
      source: "HOME_ACCESSORY_ORDER_IMPORT",
      itemType: "OTHER",
      stockLocationId: 3,
    });
  });

  it("sets draftPoId to null for a row excluded from every PO", () => {
    const row = effectiveRow({ poExcluded: true });
    const body = buildHomeAccessoryItemCreateBody(row, null, ctx());
    expect(body.draftPoId).toBeNull();
  });

  it("retail falls back: selling, then msrp, then cost — never left blank", () => {
    const withSelling = buildHomeAccessoryItemCreateBody(
      effectiveRow({ selling: 99.95, msrp: 120, cost: 39.99 }),
      1,
      ctx(),
    );
    expect(withSelling.retail).toBe(99.95);

    const withMsrpOnly = buildHomeAccessoryItemCreateBody(
      effectiveRow({ selling: null, msrp: 56, cost: 24.75 }),
      1,
      ctx(),
    );
    expect(withMsrpOnly.retail).toBe(56);

    const costOnly = buildHomeAccessoryItemCreateBody(
      effectiveRow({ selling: null, msrp: null, cost: 39.99 }),
      1,
      ctx(),
    );
    expect(costOnly.retail).toBe(39.99);
  });

  it("msrp stays null when nothing was typed and no markup applied — never guesses at retail", () => {
    const body = buildHomeAccessoryItemCreateBody(
      effectiveRow({ selling: null, msrp: null }),
      1,
      ctx(),
    );
    expect(body.msrp).toBeNull();
  });

  it("coerces an empty barcode to null rather than an empty string", () => {
    const body = buildHomeAccessoryItemCreateBody(effectiveRow({ barcode: "" }), 1, ctx());
    expect(body.barcode).toBeNull();
  });

  it("stockProgram is true iff a stockFamily was typed", () => {
    // Base fixture has no stockFamily set -> falsy -> not a stock item.
    const withoutFamily = buildHomeAccessoryItemCreateBody(effectiveRow(), 1, ctx());
    expect(withoutFamily.stockProgram).toBe(false);
    expect(withoutFamily.stockFamily).toBeNull();

    const body = buildHomeAccessoryItemCreateBody(
      effectiveRow({ stockFamily: "Bevel Arm Stocking" }),
      1,
      ctx(),
    );
    expect(body.stockProgram).toBe(true);
    expect(body.stockFamily).toBe("Bevel Arm Stocking");
  });

  it("itemType is always OTHER — home accessories use neither UPHOLSTERY nor CASE_GOODS templates", () => {
    const body = buildHomeAccessoryItemCreateBody(effectiveRow(), 1, ctx());
    expect(body.itemType).toBe("OTHER");
  });

  it("source is always HOME_ACCESSORY_ORDER_IMPORT", () => {
    const body = buildHomeAccessoryItemCreateBody(effectiveRow(), 1, ctx());
    expect(body.source).toBe("HOME_ACCESSORY_ORDER_IMPORT");
  });

  it("stamps notes with the source label and the row's order reference", () => {
    const body = buildHomeAccessoryItemCreateBody(
      effectiveRow({ reference: "0002592360" }),
      1,
      ctx({ sourceLabel: "Home Accessory Order Import — K & K Interiors" }),
    );
    expect(body.notes).toBe("Home Accessory Order Import — K & K Interiors — order 0002592360");
  });
});

describe("poReconciliationTotal / composedTotal", () => {
  it("poReconciliationTotal excludes rows taken off the PO", () => {
    const rows = [
      effectiveRow({ key: "0", qty: 2, cost: 10, poExcluded: false }),
      effectiveRow({ key: "1", qty: 1, cost: 5, poExcluded: true }),
    ];
    expect(poReconciliationTotal(rows)).toBe(20);
    expect(composedTotal(rows)).toBe(25);
  });

  it("both are 0 for an empty row list", () => {
    expect(poReconciliationTotal([])).toBe(0);
    expect(composedTotal([])).toBe(0);
  });
});

describe("unclassifiedRowCount", () => {
  it("counts rows missing either a department or a category", () => {
    const rows = [
      effectiveRow({ key: "0", departmentId: 1, categoryId: 10 }),
      effectiveRow({ key: "1", departmentId: null, categoryId: 10 }),
      effectiveRow({ key: "2", departmentId: 1, categoryId: null }),
      effectiveRow({ key: "3", departmentId: null, categoryId: null }),
    ];
    expect(unclassifiedRowCount(rows)).toBe(3);
  });

  it("is 0 when every row is classified", () => {
    const rows = [effectiveRow({ departmentId: 1, categoryId: 10 })];
    expect(unclassifiedRowCount(rows)).toBe(0);
  });
});
