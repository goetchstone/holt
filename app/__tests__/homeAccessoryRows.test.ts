// /app/__tests__/homeAccessoryRows.test.ts
//
// Pins the row composition the Home Accessory Order Import page builds
// BuyerDraftItems from: how a split set becomes one row per piece, and the
// precedence that decides each row's MONEY and CLASSIFICATION. Ported from
// furniture-configurator's __tests__/homeAccessoryRows.test.ts (which
// pinned the same composition for Ordorite CSV export) — the split-set
// math and precedence rules are unchanged. Dropped: the catalog-match
// ("adopt an existing catalog split") tests, since holt's buyer drafts
// have no catalog-match step (see homeAccessoryRows.ts header comment) —
// replaced with tests confirming a split's classification still inherits
// from the run default / a per-row pick without a match to fall back to.

import {
  composeHomeAccessoryRows,
  groupRowsForRender,
  type ComposeInput,
  type RowEdits,
} from "@/lib/homeAccessoryRows";
import type { HomeAccessoryExportRow, HomeAccessoryDraft } from "@/lib/homeAccessoryOrders";

function row(overrides: Partial<HomeAccessoryExportRow> = {}): HomeAccessoryExportRow {
  return {
    partNumber: "17695A",
    styleNumber: "17695A",
    productName: "Set of 3 Dark Mango Wood Candleholders",
    color: "",
    size: "",
    qty: 6,
    cost: 56.99,
    msrp: null,
    selling: null,
    department: "",
    category: "",
    supplier: "K & K Interiors",
    barcode: "840220407476",
    reference: "0002592361",
    ...overrides,
  };
}

function draft(rows: HomeAccessoryExportRow[]): HomeAccessoryDraft {
  return {
    vendorName: "K & K Interiors",
    customerPo: "PON09025",
    orderDate: "Jun 15, 2026",
    orders: [{ orderNumber: "0002592361", requiredDate: "9/1/26", itemCount: rows.length }],
    rows,
    warnings: [],
  };
}

function emptyEdits(): RowEdits {
  return {
    rowDepts: {},
    rowCats: {},
    sellings: {},
    msrps: {},
    names: {},
    descriptions: {},
    barcodes: {},
    poExcluded: {},
    partNumbers: {},
  };
}

function input(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    draft: draft([row()]),
    splits: {},
    edits: emptyEdits(),
    stockFamily: "",
    poNumbers: {},
    departments: [
      { id: 1, name: "Home Acc" },
      { id: 2, name: "Floral" },
    ],
    categories: [
      { id: 10, name: "Candleholder", departmentId: 1 },
      { id: 11, name: "Decor", departmentId: 1 },
      { id: 20, name: "Floral", departmentId: 2 },
    ],
    defaultDepartmentId: null,
    defaultCategoryId: null,
    markup: Number.NaN,
    supplier: "K & K Interiors",
    prefix: "KKI",
    ...overrides,
  };
}

describe("composeHomeAccessoryRows — unsplit lines", () => {
  it("prefixes the part number and keeps the manufacturer UPC", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.partNumber).toBe("KKI-17695A");
    expect(r.barcode).toBe("840220407476");
    expect(r.cost).toBe(56.99);
    expect(r.isSplitChild).toBe(false);
    expect(r.setSize).toBe(3);
    // No draftPoId concept at this layer — that's assigned later by
    // homeAccessoryBuyerDraftMapping.ts once rows are grouped into POs.
    expect(r.poExcluded).toBe(false);
  });
});

describe("composeHomeAccessoryRows — split sets (buyer sets the split amounts manually)", () => {
  // The real KKI-17695A allocation: 25.64 + 18.81 + 12.54 = 56.99 exactly.
  // Typed as dollars, NOT reachable from a round percentage (45% of 56.99
  // is 25.6455 -> 25.65), which is exactly why the cost field is editable
  // and is the source of truth.
  const manual = {
    0: [
      { suffix: "LG", cost: "25.64" },
      { suffix: "MD", cost: "18.81" },
      { suffix: "SM", cost: "12.54" },
    ],
  };

  it("carries hand-typed dollar amounts through to the composed rows, to the penny", () => {
    const rows = composeHomeAccessoryRows(input({ splits: manual }));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.partNumber)).toEqual([
      "KKI-17695A-LG",
      "KKI-17695A-MD",
      "KKI-17695A-SM",
    ]);
    expect(rows.map((r) => r.cost)).toEqual([25.64, 18.81, 12.54]);
    // The pieces reconcile to the set's own cost — the invariant the
    // reconciliation banner and the PO-creation flow both depend on.
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(56.99, 2);
  });

  it("gives every piece the SET's qty, so the PO total still matches the vendor's own line", () => {
    const rows = composeHomeAccessoryRows(input({ splits: manual }));
    expect(rows.map((r) => r.qty)).toEqual([6, 6, 6]);
    const poTotal = rows.reduce((s, r) => s + r.qty * r.cost, 0);
    expect(poTotal).toBeCloseTo(6 * 56.99, 2);
  });

  it("suffixes each piece's barcode -1 -2 -3 so they stay unique", () => {
    const rows = composeHomeAccessoryRows(input({ splits: manual }));
    expect(rows.map((r) => r.barcode)).toEqual([
      "840220407476-1",
      "840220407476-2",
      "840220407476-3",
    ]);
    expect(new Set(rows.map((r) => r.barcode)).size).toBe(3);
  });

  it("leaves the pieces blank when the set has no printed UPC", () => {
    const rows = composeHomeAccessoryRows(
      input({ draft: draft([row({ barcode: "" })]), splits: manual }),
    );
    expect(rows.map((r) => r.barcode)).toEqual(["", "", ""]);
  });

  it("an unparseable typed cost becomes 0 rather than NaN reaching the create payload", () => {
    const rows = composeHomeAccessoryRows(
      input({
        splits: {
          0: [
            { suffix: "LG", cost: "" },
            { suffix: "SM", cost: "abc" },
          ],
        },
      }),
    );
    expect(rows.map((r) => r.cost)).toEqual([0, 0]);
  });
});

describe("composeHomeAccessoryRows — value precedence (no catalog match layer in holt)", () => {
  it("a per-row pick beats the run default", () => {
    const [viaDefault] = composeHomeAccessoryRows(
      input({ defaultDepartmentId: 1, defaultCategoryId: 11 }),
    );
    expect(viaDefault.department).toBe("Home Acc");
    expect(viaDefault.category).toBe("Decor");

    const [viaPick] = composeHomeAccessoryRows(
      input({
        defaultDepartmentId: 1,
        defaultCategoryId: 11,
        edits: { ...emptyEdits(), rowDepts: { "0": 2 }, rowCats: { "0": 20 } },
      }),
    );
    expect(viaPick.department).toBe("Floral");
    expect(viaPick.category).toBe("Floral");
  });

  it("markup fills Selling AND MSRP, and a typed price beats the markup", () => {
    const [marked] = composeHomeAccessoryRows(input({ markup: 2.5 }));
    // 56.99 x 2.5 = 142.475 -> up to the next 5-or-9 ending, whole dollars.
    expect(marked.selling).toBe(145);
    expect(marked.msrp).toBe(145);
    const [typed] = composeHomeAccessoryRows(
      input({
        markup: 2.5,
        edits: { ...emptyEdits(), sellings: { "0": "149.95" } },
      }),
    );
    expect(typed.selling).toBe(149.95);
    expect(typed.msrp).toBe(145);
  });

  it("no markup leaves prices null — these documents carry no retail", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.selling).toBeNull();
    expect(r.msrp).toBeNull();
  });
});

describe("composeHomeAccessoryRows — PO numbers per order", () => {
  const twoOrderDraft = () => {
    const a = row({ partNumber: "AAA", reference: "0002592360" });
    const b = row({ partNumber: "BBB", reference: "0002592361" });
    return {
      ...draft([a, b]),
      orders: [
        { orderNumber: "0002592360", requiredDate: "8/1/26", itemCount: 1 },
        { orderNumber: "0002592361", requiredDate: "9/1/26", itemCount: 1 },
      ],
    };
  };

  it("leaves each order on its own vendor order number when nothing is typed", () => {
    const rows = composeHomeAccessoryRows(input({ draft: twoOrderDraft() }));
    expect(rows.map((r) => r.reference)).toEqual(["0002592360", "0002592361"]);
  });

  it("applies a typed PO to ONLY that order, leaving the other alone", () => {
    // The bug this guards: a single run-level PO number overriding every
    // row would silently merge a two-order bundle into ONE draft PO.
    const rows = composeHomeAccessoryRows(
      input({ draft: twoOrderDraft(), poNumbers: { "0002592360": "PON09025" } }),
    );
    expect(rows.map((r) => r.reference)).toEqual(["PON09025", "0002592361"]);
  });

  it("keeps two typed POs distinct, so two draft POs still get created", () => {
    const rows = composeHomeAccessoryRows(
      input({
        draft: twoOrderDraft(),
        poNumbers: { "0002592360": "PO-A", "0002592361": "PO-B" },
      }),
    );
    expect(rows.map((r) => r.reference)).toEqual(["PO-A", "PO-B"]);
    expect(new Set(rows.map((r) => r.reference)).size).toBe(2);
  });

  it("treats a blank or whitespace entry as 'use the vendor's number'", () => {
    const rows = composeHomeAccessoryRows(
      input({ draft: twoOrderDraft(), poNumbers: { "0002592360": "   " } }),
    );
    expect(rows[0].reference).toBe("0002592360");
  });

  it("lets one typed PO deliberately cover both orders when that is the intent", () => {
    const rows = composeHomeAccessoryRows(
      input({
        draft: twoOrderDraft(),
        poNumbers: { "0002592360": "PON1", "0002592361": "PON1" },
      }),
    );
    expect(new Set(rows.map((r) => r.reference)).size).toBe(1);
  });

  it("carries the order's PO onto every piece of a split set", () => {
    const setRow = row({ partNumber: "17695A", reference: "0002592360" });
    const d = {
      ...draft([setRow]),
      orders: [{ orderNumber: "0002592360", requiredDate: "", itemCount: 1 }],
    };
    const rows = composeHomeAccessoryRows(
      input({
        draft: d,
        poNumbers: { "0002592360": "PON09025" },
        splits: {
          0: [
            { suffix: "LG", cost: "22.79" },
            { suffix: "MD", cost: "19.95" },
            { suffix: "SM", cost: "14.25" },
          ],
        },
      }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.reference === "PON09025")).toBe(true);
  });
});

describe("composeHomeAccessoryRows — parsed descriptions", () => {
  const PARSED_DESC = 'Medium: Canvas Treatment: Gallery Wrapped Size: 35.01"w x 41.01"h';

  it("keeps the parsed description when the buyer has not typed one", () => {
    const [r] = composeHomeAccessoryRows(
      input({ draft: draft([row({ description: PARSED_DESC })]) }),
    );
    expect(r.description).toBe(PARSED_DESC);
  });

  it("lets a typed description win over the parsed one", () => {
    const [r] = composeHomeAccessoryRows(
      input({
        draft: draft([row({ description: PARSED_DESC })]),
        edits: { ...emptyEdits(), descriptions: { "0": "Hand-written tag copy" } },
      }),
    );
    expect(r.description).toBe("Hand-written tag copy");
  });

  it("treats a cleared box as 'compose one for me', not as the parsed text", () => {
    const [r] = composeHomeAccessoryRows(
      input({
        draft: draft([row({ description: PARSED_DESC })]),
        edits: { ...emptyEdits(), descriptions: { "0": "" } },
      }),
    );
    expect(r.description).toBe("");
  });

  it("leaves K&K rows undisturbed — their documents carry no description", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.description).toBeUndefined();
  });
});

describe("composeHomeAccessoryRows — split pieces rename themselves", () => {
  const trio = {
    0: [
      { suffix: "LG", cost: "25.64" },
      { suffix: "MD", cost: "18.81" },
      { suffix: "SM", cost: "12.54" },
    ],
  };

  it("drops 'Set of N' and says which piece it is", () => {
    const rows = composeHomeAccessoryRows(input({ splits: trio }));
    expect(rows.map((r) => r.productName)).toEqual([
      "Dark Mango Wood Candleholders Large",
      "Dark Mango Wood Candleholders Medium",
      "Dark Mango Wood Candleholders Small",
    ]);
  });

  it("gives the description the same text as the name", () => {
    const rows = composeHomeAccessoryRows(input({ splits: trio }));
    expect(rows.map((r) => r.description)).toEqual([
      "Dark Mango Wood Candleholders Large",
      "Dark Mango Wood Candleholders Medium",
      "Dark Mango Wood Candleholders Small",
    ]);
  });

  it("leaves an UNSPLIT row's name exactly as the vendor wrote it", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.productName).toBe("Set of 3 Dark Mango Wood Candleholders");
  });

  it("keeps the split action visible after renaming", () => {
    const rows = composeHomeAccessoryRows(input({ splits: trio }));
    expect(rows.every((r) => r.setSize === 3)).toBe(true);
  });

  it("lets a typed name beat the generated one", () => {
    const rows = composeHomeAccessoryRows(
      input({ splits: trio, edits: { ...emptyEdits(), names: { "0:0": "Hand-written" } } }),
    );
    expect(rows[0].productName).toBe("Hand-written");
    expect(rows[1].productName).toBe("Dark Mango Wood Candleholders Medium");
  });

  it("uses an unrecognised suffix verbatim rather than guessing", () => {
    const rows = composeHomeAccessoryRows(
      input({ splits: { 0: [{ suffix: "TALL", cost: "1" }] } }),
    );
    expect(rows[0].productName).toBe("Dark Mango Wood Candleholders TALL");
  });
});

describe("composeHomeAccessoryRows — resolved ids travel with the row", () => {
  const duplicateNames = [
    { id: 173, name: "Accessory", departmentId: 2 }, // Furniture — comes FIRST
    { id: 440, name: "Accessory", departmentId: 15 }, // Home Acc — the real pick
  ];

  it("keeps the id the row was composed from, not the first same-named one", () => {
    const [r] = composeHomeAccessoryRows(
      input({
        departments: [
          { id: 15, name: "Home Acc" },
          { id: 2, name: "Furniture" },
        ],
        categories: duplicateNames,
        defaultDepartmentId: 15,
        defaultCategoryId: 440,
      }),
    );
    expect(r.categoryId).toBe(440);
    expect(r.departmentId).toBe(15);
    expect(r.category).toBe("Accessory");
    expect(r.department).toBe("Home Acc");
  });

  it("keeps a per-row pick distinct from a same-named category elsewhere", () => {
    const [r] = composeHomeAccessoryRows(
      input({
        departments: [
          { id: 15, name: "Home Acc" },
          { id: 2, name: "Furniture" },
        ],
        categories: duplicateNames,
        edits: { ...emptyEdits(), rowDepts: { "0": 2 }, rowCats: { "0": 173 } },
      }),
    );
    expect(r.categoryId).toBe(173);
    expect(r.departmentId).toBe(2);
  });

  it("carries nulls when nothing is chosen", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.categoryId).toBeNull();
    expect(r.departmentId).toBeNull();
  });
});

describe("composeHomeAccessoryRows — hand-typed part numbers", () => {
  it("lets a typed part number win over the composed one", () => {
    const [r] = composeHomeAccessoryRows(
      input({ edits: { ...emptyEdits(), partNumbers: { "0": "KKI-CUSTOM-1" } } }),
    );
    expect(r.partNumber).toBe("KKI-CUSTOM-1");
  });

  it("falls back to the composed default when the box is cleared", () => {
    const [r] = composeHomeAccessoryRows(
      input({ edits: { ...emptyEdits(), partNumbers: { "0": "   " } } }),
    );
    expect(r.partNumber).toBe("KKI-17695A");
  });

  it("lets each split piece carry its own typed number", () => {
    const rows = composeHomeAccessoryRows(
      input({
        splits: {
          0: [
            { suffix: "LG", cost: "25.64" },
            { suffix: "MD", cost: "18.81" },
          ],
        },
        edits: { ...emptyEdits(), partNumbers: { "0:1": "KKI-HAND-MD" } },
      }),
    );
    expect(rows[0].partNumber).toBe("KKI-17695A-LG");
    expect(rows[1].partNumber).toBe("KKI-HAND-MD");
  });
});

describe("composeHomeAccessoryRows — split pieces inherit the parent's classification", () => {
  const trio = {
    0: [
      { suffix: "LG", cost: "25.64" },
      { suffix: "MD", cost: "18.81" },
      { suffix: "SM", cost: "12.54" },
    ],
  };
  const depts = [
    { id: 15, name: "Home Acc" },
    { id: 2, name: "Furniture" },
  ];
  const cats = [
    { id: 440, name: "Accessory", departmentId: 15 },
    { id: 173, name: "Accessory", departmentId: 2 },
  ];

  it("gives every piece the SAME classification from the run default", () => {
    const rows = composeHomeAccessoryRows(
      input({
        splits: trio,
        departments: depts,
        categories: cats,
        defaultDepartmentId: 15,
        defaultCategoryId: 440,
      }),
    );
    expect(rows.map((r) => r.department)).toEqual(["Home Acc", "Home Acc", "Home Acc"]);
    expect(rows.map((r) => r.categoryId)).toEqual([440, 440, 440]);
  });

  it("inherits a parent-level row pick made before the split", () => {
    const rows = composeHomeAccessoryRows(
      input({
        splits: trio,
        departments: depts,
        categories: cats,
        defaultDepartmentId: 15,
        defaultCategoryId: 440,
        edits: { ...emptyEdits(), rowDepts: { "0": 2 }, rowCats: { "0": 173 } },
      }),
    );
    expect(rows.every((r) => r.department === "Furniture")).toBe(true);
    expect(rows.every((r) => r.categoryId === 173)).toBe(true);
  });

  it("still lets the buyer override ONE piece", () => {
    const rows = composeHomeAccessoryRows(
      input({
        splits: trio,
        departments: depts,
        categories: cats,
        defaultDepartmentId: 15,
        defaultCategoryId: 440,
        edits: { ...emptyEdits(), rowDepts: { "0:1": 2 }, rowCats: { "0:1": 173 } },
      }),
    );
    expect(rows.map((r) => r.department)).toEqual(["Home Acc", "Furniture", "Home Acc"]);
  });
});

describe("composeHomeAccessoryRows — poExcluded ('off PO but still a draft item')", () => {
  it("defaults to false (on the PO)", () => {
    const [r] = composeHomeAccessoryRows(input());
    expect(r.poExcluded).toBe(false);
  });

  it("respects a buyer's exclusion", () => {
    const [r] = composeHomeAccessoryRows(
      input({ edits: { ...emptyEdits(), poExcluded: { "0": true } } }),
    );
    expect(r.poExcluded).toBe(true);
  });
});

describe("groupRowsForRender — split sets read as distinct blocks", () => {
  const mixed = () =>
    input({
      draft: draft([
        row({ partNumber: "PLAIN1", productName: "Brown Resin Horse" }),
        row({ partNumber: "SETA", productName: "Set of 3 Candleholders" }),
        row({ partNumber: "SETB", productName: "Set of 2 Vases", cost: 40 }),
        row({ partNumber: "PLAIN2", productName: "Ceramic Bowl" }),
      ]),
      splits: {
        1: [
          { suffix: "LG", cost: "25.64" },
          { suffix: "MD", cost: "18.81" },
          { suffix: "SM", cost: "12.54" },
        ],
        2: [
          { suffix: "LG", cost: "22.00" },
          { suffix: "SM", cost: "18.00" },
        ],
      },
    });

  it("collapses each split set's pieces into one group, plain lines stay single", () => {
    const blocks = groupRowsForRender(composeHomeAccessoryRows(mixed()));
    expect(blocks.map((b) => b.kind)).toEqual(["single", "splitGroup", "splitGroup", "single"]);
    const groups = blocks.filter((b) => b.kind === "splitGroup");
    expect(groups[0]).toMatchObject({ rowIndex: 1, groupOrdinal: 0 });
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[1]).toMatchObject({ rowIndex: 2, groupOrdinal: 1 });
    expect(groups[1].rows).toHaveLength(2);
  });

  it("gives back-to-back split groups DIFFERENT ordinals so accents alternate", () => {
    const blocks = groupRowsForRender(composeHomeAccessoryRows(mixed()));
    const ordinals = blocks
      .filter((b) => b.kind === "splitGroup")
      .map((b) => (b.kind === "splitGroup" ? b.groupOrdinal : -1));
    expect(ordinals).toEqual([0, 1]);
    expect(ordinals[0] % 2).not.toBe(ordinals[1] % 2);
  });

  it("every piece of a group shares its parsed line's rowIndex", () => {
    const blocks = groupRowsForRender(composeHomeAccessoryRows(mixed()));
    for (const b of blocks) {
      if (b.kind !== "splitGroup") continue;
      expect(b.rows.every((r) => r.rowIndex === b.rowIndex)).toBe(true);
      expect(b.rows.every((r) => r.isSplitChild)).toBe(true);
    }
  });

  it("returns all singles when nothing is split", () => {
    const blocks = groupRowsForRender(composeHomeAccessoryRows(input()));
    expect(blocks).toEqual([
      { kind: "single", row: expect.objectContaining({ isSplitChild: false }) },
    ]);
  });

  it("keeps a lone split set as one group at ordinal 0", () => {
    const blocks = groupRowsForRender(
      composeHomeAccessoryRows(
        input({
          splits: {
            0: [
              { suffix: "LG", cost: "30.00" },
              { suffix: "SM", cost: "26.99" },
            ],
          },
        }),
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "splitGroup", rowIndex: 0, groupOrdinal: 0 });
  });
});
