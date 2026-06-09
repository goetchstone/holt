// /app/__tests__/buyerDraftRealPoLink.test.ts
//
// A-grade unit tests for the buyer-draft → real-PO linking helper.
// Fixture inputs mirror the actual prod data we proved the helper
// against on 2026-05-14 (Spring 2026 buy, 20 real PONs, 80 drafts):
// 1:1 mappings, 1:N (draft PO 3 covering 3 real PONs), partial real
// PO coverage (some real-PO lines outside the draft), and unmatched
// drafts (both null-link and no-matching-real-PO reasons).

import {
  computeLinkedPos,
  detectVendorMismatches,
  type DraftItemInput,
  type DraftPoInput,
  type RealPoInput,
  type RealPoLineInput,
} from "@/lib/buyerDraftRealPoLink";

describe("computeLinkedPos", () => {
  it("returns empty result for a Buy with no drafts", () => {
    const result = computeLinkedPos([], [], [], []);
    expect(result.totals.draftItems).toBe(0);
    expect(result.totals.matchedRealPos).toBe(0);
    expect(result.realPos).toEqual([]);
    expect(result.draftPos).toEqual([]);
    expect(result.unmatchedDrafts).toEqual([]);
  });

  it("matches a 1:1 draft → real PO (single line each)", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "AL-BNY",
        productName: "Bentley",
        vendorName: "American Leather",
        fulfilledProductId: 1543,
        draftPoId: 100,
      },
    ];
    const draftPos: DraftPoInput[] = [{ id: 100, vendorName: "American Leather" }];
    const realPos: RealPoInput[] = [
      {
        id: 200,
        poNumber: "PON07266",
        vendor: "American Leather",
        vendorId: 2,
        orderDate: new Date("2025-11-08"),
        status: "RECEIVED_FULL",
      },
    ];
    const realPoLines: RealPoLineInput[] = [{ realPoId: 200, productId: 1543, orderedQuantity: 3 }];

    const result = computeLinkedPos(drafts, draftPos, realPos, realPoLines);
    expect(result.totals).toMatchObject({
      draftItems: 1,
      draftItemsLinked: 1,
      draftPos: 1,
      matchedRealPos: 1,
      unmatchedDraftItems: 0,
    });
    expect(result.realPos).toHaveLength(1);
    expect(result.realPos[0]).toMatchObject({
      poNumber: "PON07266",
      matchedLines: 1,
      totalLines: 1,
      matchedQty: 3,
      totalQty: 3,
    });
    expect(result.draftPos[0].linkedRealPoNumbers).toEqual(["PON07266"]);
  });

  it("handles 1:N draft PO spanning multiple real POs (Bradington Young case)", () => {
    // Mirrors the actual Spring 2026 draft PO 3 → PON07054 + PON07576 + PON08313
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "BRAD-3033",
        productName: "Kipton",
        vendorName: "Bradington Young",
        fulfilledProductId: 5479,
        draftPoId: 3,
      },
      {
        id: 2,
        partNumber: "BRAD-4114",
        productName: "Chippendale Recliner",
        vendorName: "Bradington Young",
        fulfilledProductId: 5385,
        draftPoId: 3,
      },
      {
        id: 3,
        partNumber: "BRAD-8010",
        productName: "Ryder Lift Chair",
        vendorName: "Bradington Young",
        fulfilledProductId: 5619,
        draftPoId: 3,
      },
    ];
    const draftPos: DraftPoInput[] = [{ id: 3, vendorName: "Bradington Young" }];
    const realPos: RealPoInput[] = [
      {
        id: 100,
        poNumber: "PON07054",
        vendor: "Bradington Young",
        vendorId: 12,
        orderDate: new Date("2025-10-21"),
        status: "RECEIVED_FULL",
      },
      {
        id: 101,
        poNumber: "PON07576",
        vendor: "Bradington Young",
        vendorId: 12,
        orderDate: new Date("2025-12-16"),
        status: "RECEIVED_FULL",
      },
      {
        id: 102,
        poNumber: "PON08313",
        vendor: "Bradington Young",
        vendorId: 12,
        orderDate: new Date("2026-03-27"),
        status: "CONFIRMED",
      },
    ];
    const realPoLines: RealPoLineInput[] = [
      { realPoId: 100, productId: 5479, orderedQuantity: 1 },
      { realPoId: 101, productId: 5385, orderedQuantity: 1 },
      { realPoId: 102, productId: 5619, orderedQuantity: 1 },
    ];

    const result = computeLinkedPos(drafts, draftPos, realPos, realPoLines);
    expect(result.totals.matchedRealPos).toBe(3);
    expect(result.draftPos[0].linkedRealPoNumbers).toEqual(["PON07054", "PON07576", "PON08313"]);
    // Sorted oldest-first within vendor
    expect(result.realPos.map((p) => p.poNumber)).toEqual(["PON07054", "PON07576", "PON08313"]);
  });

  it("reports partial real-PO coverage (real PO has extra lines not on draft)", () => {
    // Mirrors PON07817 (CRL) — 4 of 10 lines drafted, 6 unrelated.
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "CRL-A",
        productName: "Sofa A",
        vendorName: "CRL",
        fulfilledProductId: 100,
        draftPoId: 4,
      },
    ];
    const draftPos: DraftPoInput[] = [{ id: 4, vendorName: "CRL" }];
    const realPos: RealPoInput[] = [
      {
        id: 50,
        poNumber: "PON07817",
        vendor: "CRL",
        vendorId: 14,
        orderDate: new Date("2026-01-26"),
        status: "RECEIVED_FULL",
      },
    ];
    const realPoLines: RealPoLineInput[] = [
      { realPoId: 50, productId: 100, orderedQuantity: 2 }, // matched
      { realPoId: 50, productId: 999, orderedQuantity: 1 }, // extra
      { realPoId: 50, productId: 998, orderedQuantity: 1 }, // extra
    ];

    const result = computeLinkedPos(drafts, draftPos, realPos, realPoLines);
    expect(result.realPos[0]).toMatchObject({
      matchedLines: 1,
      totalLines: 3,
      matchedQty: 2,
      totalQty: 4,
    });
  });

  it("flags drafts with no link as unmatched (`no-link`)", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "NEW-ITEM",
        productName: "Not in catalog yet",
        vendorName: "Wesley Hall",
        fulfilledProductId: null,
        draftPoId: 13,
      },
    ];
    const result = computeLinkedPos(drafts, [{ id: 13, vendorName: "Wesley Hall" }], [], []);
    expect(result.totals).toMatchObject({
      draftItems: 1,
      draftItemsLinked: 0,
      matchedRealPos: 0,
      unmatchedDraftItems: 1,
    });
    expect(result.unmatchedDrafts[0]).toMatchObject({
      partNumber: "NEW-ITEM",
      reason: "no-link",
    });
  });

  it("flags drafts whose linked Product isn't on any real PO yet (`not-on-any-real-po`)", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "LINKED-BUT-UNORDERED",
        productName: "Has catalog row",
        vendorName: "Hooker",
        fulfilledProductId: 999,
        draftPoId: 10,
      },
    ];
    // No real PO lines reference productId=999.
    const result = computeLinkedPos(drafts, [{ id: 10, vendorName: "Hooker" }], [], []);
    expect(result.unmatchedDrafts[0]).toMatchObject({
      partNumber: "LINKED-BUT-UNORDERED",
      reason: "not-on-any-real-po",
    });
  });

  it("sorts real POs by vendor then orderDate ascending", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "A",
        productName: "x",
        vendorName: "v",
        fulfilledProductId: 1,
        draftPoId: 1,
      },
      {
        id: 2,
        partNumber: "B",
        productName: "y",
        vendorName: "v",
        fulfilledProductId: 2,
        draftPoId: 1,
      },
    ];
    const realPos: RealPoInput[] = [
      {
        id: 30,
        poNumber: "PON-LATE-A",
        vendor: "A",
        vendorId: 1,
        orderDate: new Date("2026-03-01"),
        status: "x",
      },
      {
        id: 20,
        poNumber: "PON-EARLY-Z",
        vendor: "Z",
        vendorId: 2,
        orderDate: new Date("2025-10-01"),
        status: "x",
      },
      {
        id: 10,
        poNumber: "PON-EARLY-A",
        vendor: "A",
        vendorId: 1,
        orderDate: new Date("2025-10-01"),
        status: "x",
      },
    ];
    const realPoLines: RealPoLineInput[] = [
      { realPoId: 10, productId: 1, orderedQuantity: 1 },
      { realPoId: 20, productId: 2, orderedQuantity: 1 },
      { realPoId: 30, productId: 1, orderedQuantity: 1 },
    ];
    const result = computeLinkedPos(drafts, [{ id: 1, vendorName: "v" }], realPos, realPoLines);
    expect(result.realPos.map((p) => p.poNumber)).toEqual([
      "PON-EARLY-A",
      "PON-LATE-A",
      "PON-EARLY-Z",
    ]);
  });

  it("dedupes when one product appears on multiple real POs", () => {
    // The same productId can appear on multiple real POs (e.g., a
    // stock item reordered later). Both POs should be matched, not
    // de-duped against each other.
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "X",
        productName: "x",
        vendorName: "v",
        fulfilledProductId: 5,
        draftPoId: 1,
      },
    ];
    const realPos: RealPoInput[] = [
      {
        id: 10,
        poNumber: "PON-A",
        vendor: "v",
        vendorId: 1,
        orderDate: new Date("2025-10-01"),
        status: "x",
      },
      {
        id: 11,
        poNumber: "PON-B",
        vendor: "v",
        vendorId: 1,
        orderDate: new Date("2026-01-01"),
        status: "x",
      },
    ];
    const realPoLines: RealPoLineInput[] = [
      { realPoId: 10, productId: 5, orderedQuantity: 1 },
      { realPoId: 11, productId: 5, orderedQuantity: 2 },
    ];
    const result = computeLinkedPos(drafts, [{ id: 1, vendorName: "v" }], realPos, realPoLines);
    expect(result.totals.matchedRealPos).toBe(2);
    expect(result.draftPos[0].linkedRealPoNumbers).toEqual(["PON-A", "PON-B"]);
  });

  it("ignores real-PO lines with no productId", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "X",
        productName: "x",
        vendorName: "v",
        fulfilledProductId: 5,
        draftPoId: 1,
      },
    ];
    const realPoLines: RealPoLineInput[] = [{ realPoId: 10, productId: null, orderedQuantity: 1 }];
    const result = computeLinkedPos(
      drafts,
      [{ id: 1, vendorName: "v" }],
      [
        {
          id: 10,
          poNumber: "PON",
          vendor: "v",
          vendorId: 1,
          orderDate: null,
          status: "x",
        },
      ],
      realPoLines,
    );
    expect(result.totals.matchedRealPos).toBe(0);
    expect(result.unmatchedDrafts).toHaveLength(1);
  });

  it("handles a real PO with a null orderDate (sorted last)", () => {
    const drafts: DraftItemInput[] = [
      {
        id: 1,
        partNumber: "A",
        productName: "x",
        vendorName: "v",
        fulfilledProductId: 1,
        draftPoId: 1,
      },
      {
        id: 2,
        partNumber: "B",
        productName: "y",
        vendorName: "v",
        fulfilledProductId: 2,
        draftPoId: 1,
      },
    ];
    const realPos: RealPoInput[] = [
      {
        id: 10,
        poNumber: "PON-DATED",
        vendor: "A",
        vendorId: 1,
        orderDate: new Date("2025-10-01"),
        status: "x",
      },
      {
        id: 11,
        poNumber: "PON-NULL",
        vendor: "A",
        vendorId: 1,
        orderDate: null,
        status: "x",
      },
    ];
    const result = computeLinkedPos(drafts, [{ id: 1, vendorName: "v" }], realPos, [
      { realPoId: 10, productId: 1, orderedQuantity: 1 },
      { realPoId: 11, productId: 2, orderedQuantity: 1 },
    ]);
    expect(result.realPos.map((p) => p.poNumber)).toEqual(["PON-DATED", "PON-NULL"]);
  });

  // Scope filters added 2026-05-22 after Spring 2026 audit found 72 PONs
  // surfacing on the linked-PO panel because the empirical join had no
  // date floor and treated stocking-item history as relevant.
  describe("scope filtering", () => {
    function fixture() {
      const drafts = [
        {
          id: 1,
          partNumber: "WH-A",
          productName: "Sofa",
          vendorName: "Wesley Hall",
          fulfilledProductId: 100,
          draftPoId: 1,
        },
      ];
      const draftPos = [{ id: 1, vendorName: "Wesley Hall" }];
      const realPos = [
        {
          id: 10,
          poNumber: "PON-2023",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2023, 5, 1)),
          status: "RECEIVED_FULL",
        },
        {
          id: 11,
          poNumber: "PON-2024",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2024, 5, 1)),
          status: "RECEIVED_FULL",
        },
        {
          id: 12,
          poNumber: "PON-OCT25",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2025, 9, 21)),
          status: "RECEIVED_FULL",
        },
        {
          id: 13,
          poNumber: "PON-JAN26",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2026, 0, 26)),
          status: "RECEIVED_FULL",
        },
      ];
      const lines = [
        { realPoId: 10, productId: 100, orderedQuantity: 1 },
        { realPoId: 11, productId: 100, orderedQuantity: 1 },
        { realPoId: 12, productId: 100, orderedQuantity: 1 },
        { realPoId: 13, productId: 100, orderedQuantity: 1 },
      ];
      return { drafts, draftPos, realPos, lines };
    }

    it("with no scope, surfaces all-time history (legacy behavior)", () => {
      const { drafts, draftPos, realPos, lines } = fixture();
      const r = computeLinkedPos(drafts, draftPos, realPos, lines);
      expect(r.realPos.map((p) => p.poNumber).sort()).toEqual([
        "PON-2023",
        "PON-2024",
        "PON-JAN26",
        "PON-OCT25",
      ]);
    });

    it("windowStart filters out POs whose orderDate is before the cutoff", () => {
      const { drafts, draftPos, realPos, lines } = fixture();
      // For a Spring 2026 buy with earliest ETA = 2026-01, the typical
      // window is ETA − 6 months = 2025-07. PON-2023 and PON-2024 fall
      // before that and should drop out; PON-OCT25 + PON-JAN26 stay.
      const r = computeLinkedPos(drafts, draftPos, realPos, lines, {
        windowStart: new Date(Date.UTC(2025, 6, 1)),
      });
      expect(r.realPos.map((p) => p.poNumber).sort()).toEqual(["PON-JAN26", "PON-OCT25"]);
    });

    it("windowStart keeps POs with null orderDate (defensive — usually FileMaker-era)", () => {
      const drafts = [
        {
          id: 1,
          partNumber: "WH-A",
          productName: "Sofa",
          vendorName: "WH",
          fulfilledProductId: 100,
          draftPoId: 1,
        },
      ];
      const realPos = [
        {
          id: 10,
          poNumber: "PON-NULL",
          vendor: "WH",
          vendorId: 1,
          orderDate: null,
          status: "RECEIVED_FULL",
        },
        {
          id: 11,
          poNumber: "PON-OLD",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2023, 5, 1)),
          status: "RECEIVED_FULL",
        },
      ];
      const lines = [
        { realPoId: 10, productId: 100, orderedQuantity: 1 },
        { realPoId: 11, productId: 100, orderedQuantity: 1 },
      ];
      const r = computeLinkedPos(drafts, [{ id: 1, vendorName: "v" }], realPos, lines, {
        windowStart: new Date(Date.UTC(2025, 0, 1)),
      });
      // PON-NULL kept (defensive), PON-OLD dropped
      expect(r.realPos.map((p) => p.poNumber)).toEqual(["PON-NULL"]);
    });

    it("explicitRealPoIds wins — returns ONLY the listed PO ids, ignoring windowStart", () => {
      const { drafts, draftPos, realPos, lines } = fixture();
      // Buyer used Slice 6.13 to attach PON-OCT25 + PON-JAN26 explicitly.
      // The panel must show exactly those two, not the empirical-join set.
      const r = computeLinkedPos(drafts, draftPos, realPos, lines, {
        explicitRealPoIds: new Set([12, 13]),
        // windowStart is irrelevant when explicit set is present
        windowStart: new Date(Date.UTC(2000, 0, 1)),
      });
      expect(r.realPos.map((p) => p.poNumber).sort()).toEqual(["PON-JAN26", "PON-OCT25"]);
    });

    it("empty explicitRealPoIds set falls through to windowStart (treat as not-set)", () => {
      // Defensive: caller passes `new Set()` because they queried for
      // explicit imports and got zero rows. Helper should treat this as
      // "no explicit set, apply window instead" — not "exactly nothing."
      const { drafts, draftPos, realPos, lines } = fixture();
      const r = computeLinkedPos(drafts, draftPos, realPos, lines, {
        explicitRealPoIds: new Set(),
        windowStart: new Date(Date.UTC(2025, 6, 1)),
      });
      expect(r.realPos.map((p) => p.poNumber).sort()).toEqual(["PON-JAN26", "PON-OCT25"]);
    });

    it("filters unmatchedDrafts the same way (draft items whose only PO history is out-of-window become not-on-any-real-po)", () => {
      // The draft's fulfilledProductId=100 maps to PON-2023 only (outside window).
      const drafts = [
        {
          id: 1,
          partNumber: "WH-A",
          productName: "Sofa",
          vendorName: "WH",
          fulfilledProductId: 100,
          draftPoId: 1,
        },
      ];
      const realPos = [
        {
          id: 10,
          poNumber: "PON-2023",
          vendor: "WH",
          vendorId: 1,
          orderDate: new Date(Date.UTC(2023, 5, 1)),
          status: "RECEIVED_FULL",
        },
      ];
      const lines = [{ realPoId: 10, productId: 100, orderedQuantity: 1 }];
      const r = computeLinkedPos(drafts, [{ id: 1, vendorName: "v" }], realPos, lines, {
        windowStart: new Date(Date.UTC(2025, 0, 1)),
      });
      expect(r.realPos).toHaveLength(0);
      expect(r.unmatchedDrafts).toHaveLength(1);
      expect(r.unmatchedDrafts[0].reason).toBe("not-on-any-real-po");
    });
  });
});

describe("detectVendorMismatches", () => {
  it("returns empty when vendor names match", () => {
    expect(
      detectVendorMismatches([
        {
          draftPoId: 1,
          draftVendorName: "American Leather",
          realVendorNames: ["American Leather"],
        },
      ]),
    ).toEqual([]);
  });

  it("flags the Gat Creek / Caperton case (different draft vs real)", () => {
    const result = detectVendorMismatches([
      { draftPoId: 8, draftVendorName: "Gat Creek", realVendorNames: ["Caperton"] },
    ]);
    expect(result).toEqual([
      { draftPoId: 8, draftVendorName: "Gat Creek", realVendorName: "Caperton" },
    ]);
  });

  it("is case-insensitive + whitespace-trimming", () => {
    expect(
      detectVendorMismatches([
        {
          draftPoId: 1,
          draftVendorName: "  Wesley Hall  ",
          realVendorNames: ["WESLEY HALL"],
        },
      ]),
    ).toEqual([]);
  });

  it("returns one row per (draft, real-vendor) pair when multiple real vendors", () => {
    const result = detectVendorMismatches([
      {
        draftPoId: 1,
        draftVendorName: "Gat Creek",
        realVendorNames: ["Caperton", "Wesley Hall"],
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.realVendorName).sort()).toEqual(["Caperton", "Wesley Hall"]);
  });

  it("ignores draft POs with no real vendor matches", () => {
    expect(
      detectVendorMismatches([{ draftPoId: 1, draftVendorName: "Anything", realVendorNames: [] }]),
    ).toEqual([]);
  });
});
