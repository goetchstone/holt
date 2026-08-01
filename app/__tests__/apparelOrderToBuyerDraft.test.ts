// /app/__tests__/apparelOrderToBuyerDraft.test.ts
//
// Pins the KEY adaptation for the Apparel Order Import tool: the mapping
// from a parsed vendor order (ApparelOrderDraft / ApparelOrderRow) to the
// create-body shapes holt's existing Buyer Drafts API contract
// (lib/buyerDraftRequestBody.ts) accepts. Pure, no I/O, no Prisma --
// matches the grading convention of buyerDraftRequestBody.test.ts /
// buyerDraftFromProduct-style pure-helper tests in this domain.

import {
  APPAREL_IMPORT_SOURCE,
  apparelItemDescription,
  buildApparelDraftItemBody,
  buildApparelDraftItemBodies,
  buildApparelDraftPoBody,
  buildApparelPoNotes,
  type ApparelDraftItemOptions,
  type ApparelDraftPoOptions,
} from "@/lib/apparelOrderToBuyerDraft";
import type { ApparelOrderDraft, ApparelOrderRow } from "@/lib/apparelOrderVendors";

function draftFixture(overrides: Partial<ApparelOrderDraft> = {}): ApparelOrderDraft {
  return {
    vendorName: "Faherty",
    poNumber: "PO-84421",
    orderNumber: "SO-99120",
    orderDate: "07/01/2026",
    season: "FALL 26",
    rows: [],
    ...overrides,
  };
}

function rowFixture(overrides: Partial<ApparelOrderRow> = {}): ApparelOrderRow {
  return {
    partNumber: "FTY-FD1234-M-Black",
    styleNumber: "FD1234",
    productName: "Slub Rib Tee",
    color: "Black",
    colorCode: "BLK",
    size: "M",
    qty: 2,
    cost: 38.5,
    msrp: 98,
    selling: 98,
    season: "FALL 26",
    department: "",
    category: "",
    supplier: "Faherty",
    barcode: "",
    ...overrides,
  };
}

const poOptions: ApparelDraftPoOptions = {
  vendorId: 42,
  vendorName: undefined,
  referenceNumber: undefined,
  expectedShipMonth: null,
  expectedDeliveryDate: null,
  storeLocationId: null,
  buyId: null,
};

const itemOptions: ApparelDraftItemOptions = {
  vendorId: 42,
  departmentId: 7,
  categoryId: 12,
  stockLocationId: 3,
  stockProgram: false,
};

describe("APPAREL_IMPORT_SOURCE", () => {
  it("reuses the existing APPAREL_SCAN BuyerDraftSource value (no schema migration)", () => {
    expect(APPAREL_IMPORT_SOURCE).toBe("APPAREL_SCAN");
  });
});

describe("buildApparelPoNotes", () => {
  it("composes an audit trail from the order/PO number, date, and season", () => {
    const notes = buildApparelPoNotes(draftFixture());
    expect(notes).toBe(
      "Imported via Apparel Order Import (vendor order SO-99120 / PO-84421) dated 07/01/2026, season FALL 26.",
    );
  });

  it("omits blank segments", () => {
    const notes = buildApparelPoNotes(
      draftFixture({ orderNumber: "", poNumber: "", orderDate: "", season: "" }),
    );
    expect(notes).toBe("Imported via Apparel Order Import.");
  });

  it("appends parser warnings on a second line", () => {
    const notes = buildApparelPoNotes(
      draftFixture({ warnings: ["dropped a block: qty mismatch", "grand total mismatch"] }),
    );
    expect(notes).toContain("Parser warnings: dropped a block: qty mismatch; grand total mismatch");
  });

  it("skips the warnings line entirely when there are none", () => {
    const notes = buildApparelPoNotes(draftFixture({ warnings: [] }));
    expect(notes.split("\n")).toHaveLength(1);
  });
});

describe("buildApparelDraftPoBody", () => {
  it("maps the draft + options into a BuyerDraftPoCreateBody", () => {
    const body = buildApparelDraftPoBody(draftFixture(), poOptions);
    expect(body.vendorId).toBe(42);
    expect(body.vendorName).toBe("Faherty");
    // Falls back to the document's PO number when the buyer didn't override it.
    expect(body.referenceNumber).toBe("PO-84421");
    expect(body.expectedShipMonth).toBeNull();
    expect(body.buyId).toBeNull();
    expect(body.notes).toContain("Imported via Apparel Order Import");
  });

  it("the buyer's referenceNumber override wins over the document's PO number", () => {
    const body = buildApparelDraftPoBody(draftFixture(), {
      ...poOptions,
      referenceNumber: "PO-OVERRIDE",
    });
    expect(body.referenceNumber).toBe("PO-OVERRIDE");
  });

  it("falls back to the order number when there's no PO number", () => {
    const body = buildApparelDraftPoBody(draftFixture({ poNumber: "" }), poOptions);
    expect(body.referenceNumber).toBe("SO-99120");
  });

  it("null referenceNumber when neither the buyer nor the document has one", () => {
    const body = buildApparelDraftPoBody(
      draftFixture({ poNumber: "", orderNumber: "" }),
      poOptions,
    );
    expect(body.referenceNumber).toBeNull();
  });

  it("the buyer's vendorName override wins over the document's vendor name", () => {
    const body = buildApparelDraftPoBody(draftFixture(), {
      ...poOptions,
      vendorName: "Faherty Brand (Overridden)",
    });
    expect(body.vendorName).toBe("Faherty Brand (Overridden)");
  });

  it("falls back to a placeholder vendor name when both are blank", () => {
    const body = buildApparelDraftPoBody(draftFixture({ vendorName: "" }), {
      ...poOptions,
      vendorName: "  ",
    });
    expect(body.vendorName).toBe("Unknown Vendor");
  });

  it("passes through expectedShipMonth / expectedDeliveryDate / storeLocationId / buyId", () => {
    const body = buildApparelDraftPoBody(draftFixture(), {
      ...poOptions,
      expectedShipMonth: "2026-08",
      expectedDeliveryDate: "2026-08-15",
      storeLocationId: 5,
      buyId: 9,
    });
    expect(body.expectedShipMonth).toBe("2026-08");
    expect(body.expectedDeliveryDate).toBe("2026-08-15");
    expect(body.storeLocationId).toBe(5);
    expect(body.buyId).toBe(9);
  });
});

describe("apparelItemDescription", () => {
  it("joins color and size with labels", () => {
    expect(apparelItemDescription({ color: "Black", size: "M" })).toBe("Color: Black, Size: M");
  });

  it("skips a blank color", () => {
    expect(apparelItemDescription({ color: "", size: "OS" })).toBe("Size: OS");
  });

  it("skips a blank size", () => {
    expect(apparelItemDescription({ color: "Black", size: "" })).toBe("Color: Black");
  });

  it("returns empty string when both are blank", () => {
    expect(apparelItemDescription({ color: "", size: "" })).toBe("");
  });

  it("trims whitespace-only fields", () => {
    expect(apparelItemDescription({ color: "  ", size: " M " })).toBe("Size: M");
  });
});

describe("buildApparelDraftItemBody", () => {
  it("maps a row into a BuyerDraftItemCreateBody with itemType OTHER and the apparel source stamp", () => {
    const body = buildApparelDraftItemBody(rowFixture(), 100, itemOptions);
    expect(body.vendorId).toBe(42);
    expect(body.vendorName).toBe("Faherty");
    expect(body.partNumber).toBe("FTY-FD1234-M-Black");
    expect(body.productName).toBe("Slub Rib Tee");
    expect(body.cost).toBe(38.5);
    expect(body.retail).toBe(98); // selling wins
    expect(body.msrp).toBe(98);
    expect(body.description).toBe("Color: Black, Size: M");
    expect(body.departmentId).toBe(7);
    expect(body.categoryId).toBe(12);
    expect(body.productWidth).toBeNull();
    expect(body.productLength).toBeNull();
    expect(body.productHeight).toBeNull();
    expect(body.stockProgram).toBe(false);
    expect(body.draftPoId).toBe(100);
    expect(body.qty).toBe(2);
    expect(body.stockLocationId).toBe(3);
    expect(body.source).toBe("APPAREL_SCAN");
    expect(body.itemType).toBe("OTHER");
    expect(body.notes).toBe("Vendor color code: BLK");
  });

  it("retail falls back to msrp when selling is null", () => {
    const body = buildApparelDraftItemBody(rowFixture({ selling: null }), null, itemOptions);
    expect(body.retail).toBe(98);
  });

  it("retail falls back to cost when both selling and msrp are null", () => {
    const body = buildApparelDraftItemBody(
      rowFixture({ selling: null, msrp: null }),
      null,
      itemOptions,
    );
    expect(body.retail).toBe(38.5);
  });

  it("blank barcode becomes null, not an empty string", () => {
    const body = buildApparelDraftItemBody(rowFixture({ barcode: "" }), null, itemOptions);
    expect(body.barcode).toBeNull();
  });

  it("a real barcode passes through", () => {
    const body = buildApparelDraftItemBody(
      rowFixture({ barcode: "012345678905" }),
      null,
      itemOptions,
    );
    expect(body.barcode).toBe("012345678905");
  });

  it("notes is null when the row has no vendor color code", () => {
    const body = buildApparelDraftItemBody(rowFixture({ colorCode: undefined }), null, itemOptions);
    expect(body.notes).toBeNull();
  });

  it("falls back to a placeholder vendor name when the row carries none", () => {
    const body = buildApparelDraftItemBody(rowFixture({ supplier: "" }), null, itemOptions);
    expect(body.vendorName).toBe("Unknown Vendor");
  });

  it("respects an explicit stockProgram flag", () => {
    const body = buildApparelDraftItemBody(rowFixture(), null, {
      ...itemOptions,
      stockProgram: true,
    });
    expect(body.stockProgram).toBe(true);
  });

  it("draftPoId of null passes through untouched (pre-creation call shape)", () => {
    const body = buildApparelDraftItemBody(rowFixture(), null, itemOptions);
    expect(body.draftPoId).toBeNull();
  });
});

describe("buildApparelDraftItemBodies", () => {
  it("maps every row and stamps the same draftPoId on each", () => {
    const rows = [rowFixture({ partNumber: "A" }), rowFixture({ partNumber: "B" })];
    const bodies = buildApparelDraftItemBodies(rows, 55, itemOptions);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].partNumber).toBe("A");
    expect(bodies[0].draftPoId).toBe(55);
    expect(bodies[1].partNumber).toBe("B");
    expect(bodies[1].draftPoId).toBe(55);
  });

  it("returns an empty array for an empty row list", () => {
    expect(buildApparelDraftItemBodies([], 55, itemOptions)).toEqual([]);
  });
});
