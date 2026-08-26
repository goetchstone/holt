// /app/__tests__/homeAccessoryOrders.test.ts
//
// Pins the Home Accessory Order Import registry + normalizer: the K&K
// format entry, the set-detection/split/markup helpers, and the
// bundle -> HomeAccessoryExportRow mapping that lets one document create
// several draft POs via each row's `reference`. Ported from
// furniture-configurator's __tests__/homeAccessoryOrders.test.ts — the
// normalizer logic is unchanged; only the row shape (HomeAccessoryExportRow
// instead of FC's Ordorite-CSV-shaped ApparelExportRow) differs. The
// fixture bundle below is synthetic, not read from any PDF — the parser
// (kkOrderParser.ts, already ported+tested in this repo) owns fidelity to
// the real document.

import {
  HOME_ACCESSORY_FORMATS,
  buildHomeAccessoryPartNumber,
  detectSetSize,
  splitSetCosts,
  splitCostsByPercent,
  defaultSplitPercents,
  costPercent,
  SPLIT_PRESETS,
  roundRetailUpToFiveOrNine,
  applyMarkup,
  normalizeKKBundle,
  normalizeWendoverOrder,
  normalizeMarketTimeOrder,
  normalizeBrandWiseOrder,
  normalizeAestheticMovementOrder,
  normalizeSuperCatOrder,
  normalizeSimblistOrder,
  normalizeBeatrizBallOrder,
  sameSupplier,
  normalizeSupplier,
  wendoverDescription,
} from "@/lib/homeAccessoryOrders";
import type { KKOrderBundle } from "@/lib/pricing/kkOrderParser";
import type { WendoverOrder } from "@/lib/pricing/wendoverOrderParser";
import type { MarketTimeOrder } from "@/lib/pricing/marketTimeOrderParser";
import type { BrandWiseOrder } from "@/lib/pricing/brandWiseOrderParser";
import type { AestheticMovementOrder } from "@/lib/pricing/aestheticMovementOrderParser";
import type { SuperCatOrder } from "@/lib/pricing/superCatOrderParser";
import type { SimblistOrder } from "@/lib/pricing/simblistCsvOrderParser";
import type { BeatrizBallOrder } from "@/lib/pricing/beatrizBallOrderParser";

function bundle(overrides: Partial<KKOrderBundle> = {}): KKOrderBundle {
  return {
    vendorName: "",
    customerPo: "PON00006",
    orderDate: "Jun 15, 2026",
    orders: [
      {
        orderNumber: "0009900001",
        requiredDate: "8/1/26",
        printedTotal: 4500.01,
        items: [
          {
            itemNumber: "15668B",
            description: "13.5 Inch Brown Resin Horse",
            uom: "EA",
            unitPrice: 44.50,
            qty: 4,
            requiredDate: "8/1/26",
            upc: "842657186221",
          },
          {
            itemNumber: "90021D-NA",
            description: "Set of 3 Stackable Natural Wood Cake Plates w/Glass Cloches",
            uom: "EA",
            unitPrice: 79.99,
            qty: 2,
            requiredDate: "8/1/26",
            upc: "",
          },
        ],
      },
      {
        orderNumber: "0009900002",
        requiredDate: "9/1/26",
        printedTotal: 1200.65,
        items: [
          {
            itemNumber: "17429A-TN",
            description: "Some Other K&K Item",
            uom: "EA",
            unitPrice: 25.5,
            qty: 1,
            requiredDate: "9/1/26",
            upc: "111222333444",
          },
        ],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe("HOME_ACCESSORY_FORMATS", () => {
  it("pins the K&K entry", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "kk-interiors");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("kk-order");
    expect(format?.catalogVendorName).toBe("K & K Interiors");
  });

  it("pins the Wendover entry", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "wendover");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("wendover-order");
    expect(format?.catalogVendorName).toBe("Wendover Art Group");
  });

  it("pins the MarketTime entry, which serves EVERY vendor on that form", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "market-time");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("market-time");
    // Deliberately NO catalogVendorName: the document names its own
    // manufacturer, and several vendors' reps use this same form.
    expect(format?.catalogVendorName).toBeUndefined();
  });

  it("pins the BrandWise / Zodax entry", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "brandwise-zodax");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("brandwise");
    expect(format?.catalogVendorName).toBe("Zodax");
  });

  it("pins the Aesthetic Movement entry", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "aesthetic-movement");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("aesthetic-movement");
    expect(format?.catalogVendorName).toBeUndefined();
  });

  it("pins the SuperCatSolutions entry", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "supercat");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("supercat");
    expect(format?.catalogVendorName).toBeUndefined();
  });

  it("pins the Simblist Group CSV entry — the one CSV format", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "maison-zoe-ford");
    expect(format?.accepts).toBe("csv");
    expect(format?.parser).toBe("simblist-csv");
    expect(format?.catalogVendorName).toBeUndefined();
  });

  it("pins the Beatriz Ball entry, which pins its supplier", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "beatriz-ball");
    expect(format?.accepts).toBe("pdf");
    expect(format?.parser).toBe("beatriz-ball");
    expect(format?.catalogVendorName).toBe("Beatriz Ball");
  });

  it("gives every format a distinct id and parser dispatch", () => {
    const ids = HOME_ACCESSORY_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(HOME_ACCESSORY_FORMATS.every((f) => f.notes)).toBe(true);
    const readsVendorFromDoc = new Set([
      "market-time",
      "aesthetic-movement",
      "supercat",
      "simblist-csv",
    ]);
    expect(
      HOME_ACCESSORY_FORMATS.every(
        (f) => f.catalogVendorName !== undefined || readsVendorFromDoc.has(f.parser),
      ),
    ).toBe(true);
  });
});

describe("buildHomeAccessoryPartNumber", () => {
  it("joins prefix/itemNumber/suffix, each trimmed, omitting a missing suffix", () => {
    expect(buildHomeAccessoryPartNumber("KKI", "17695A", "LG")).toBe("KKI-17695A-LG");
    expect(buildHomeAccessoryPartNumber("KKI", "15668B")).toBe("KKI-15668B");
    expect(buildHomeAccessoryPartNumber("KKI", "16498A-YE")).toBe("KKI-16498A-YE");
  });

  it("trims stray whitespace on each part", () => {
    expect(buildHomeAccessoryPartNumber(" KKI ", " 15668B ")).toBe("KKI-15668B");
  });

  it("falls back to a bare item number when the vendor has no code (holt has no partNumberPrefix)", () => {
    expect(buildHomeAccessoryPartNumber("", "15668B")).toBe("15668B");
    expect(buildHomeAccessoryPartNumber("", "17695A", "LG")).toBe("17695A-LG");
  });
});

describe("detectSetSize", () => {
  it("reads the set size from the description only", () => {
    expect(detectSetSize("Set of 3 Tan Leather Coasters")).toBe(3);
    expect(detectSetSize("Set of 2 Ceramic Vases")).toBe(2);
    expect(detectSetSize("13.5 Inch Brown Resin Horse")).toBeNull();
  });

  it("still fires from the description when UOM says EA (the UOM=EA trap)", () => {
    expect(detectSetSize("Set of 3 Stackable Natural Wood Cake Plates w/Glass Cloches")).toBe(3);
  });
});

describe("splitSetCosts", () => {
  it("splits a set price evenly in whole cents, remainder on the first part", () => {
    expect(splitSetCosts(10, 3)).toEqual([3.34, 3.33, 3.33]);
  });

  it("sums to exactly zero for a zero set price", () => {
    const split = splitSetCosts(0, 3);
    expect(split.reduce((sum, v) => sum + v, 0)).toBe(0);
  });

  it("returns [] for fewer than one part", () => {
    expect(splitSetCosts(10, 0)).toEqual([]);
    expect(splitSetCosts(10, -1)).toEqual([]);
  });

  it("sums to exactly the real K&K split-set unit prices", () => {
    const centsA = splitSetCosts(56.99, 3).reduce((sum, v) => sum + Math.round(v * 100), 0);
    expect(centsA).toBe(5699);
    const centsB = splitSetCosts(49.99, 3).reduce((sum, v) => sum + Math.round(v * 100), 0);
    expect(centsB).toBe(4999);
  });

  it("always sums to exactly setPrice for awkward values, across 2..4 parts", () => {
    const prices = [0.01, 199.99, 85.49, 56.99, 49.99, 10, 0.03];
    for (const price of prices) {
      for (let parts = 2; parts <= 4; parts++) {
        const split = splitSetCosts(price, parts);
        const totalCents = split.reduce((sum, v) => sum + Math.round(v * 100), 0);
        expect(totalCents).toBe(Math.round(price * 100));
      }
    }
  });
});

describe("roundRetailUpToFiveOrNine", () => {
  it("rounds UP to the next price ending in 5 or 9", () => {
    expect(roundRetailUpToFiveOrNine(210)).toBe(215);
    expect(roundRetailUpToFiveOrNine(211)).toBe(215);
    expect(roundRetailUpToFiveOrNine(216)).toBe(219);
    expect(roundRetailUpToFiveOrNine(220)).toBe(225);
  });

  it("leaves a price that already ends in 5 or 9 alone", () => {
    expect(roundRetailUpToFiveOrNine(215)).toBe(215);
    expect(roundRetailUpToFiveOrNine(219)).toBe(219);
    expect(roundRetailUpToFiveOrNine(9)).toBe(9);
  });

  it("never rounds DOWN — that would sell below the buyer's markup", () => {
    for (const v of [0.5, 1.2, 64.1, 142.475, 209.4, 1234.567]) {
      expect(roundRetailUpToFiveOrNine(v)).toBeGreaterThanOrEqual(v);
    }
  });

  it("always lands on a 5 or a 9, and never on cents", () => {
    for (let v = 1; v <= 400; v += 0.5) {
      const r = roundRetailUpToFiveOrNine(v);
      expect(r % 1).toBe(0);
      expect([5, 9]).toContain(r % 10);
    }
  });

  it("crosses a decade correctly", () => {
    expect(roundRetailUpToFiveOrNine(226)).toBe(229);
    expect(roundRetailUpToFiveOrNine(229.01)).toBe(235);
  });

  it("guards zero and negatives", () => {
    expect(roundRetailUpToFiveOrNine(0)).toBe(0);
    expect(roundRetailUpToFiveOrNine(-5)).toBe(0);
  });
});

describe("applyMarkup", () => {
  it("applies the markup and rounds UP to a 5 or 9", () => {
    expect(applyMarkup(25.64, 2.5)).toBe(65);
    expect(applyMarkup(84, 2.5)).toBe(215);
    expect(applyMarkup(400, 2.3)).toBe(925);
  });

  it("returns null for non-positive cost or a non-finite/non-positive markup", () => {
    expect(applyMarkup(0, 2.5)).toBeNull();
    expect(applyMarkup(10, 0)).toBeNull();
    expect(applyMarkup(10, Number.NaN)).toBeNull();
  });
});

describe("normalizeKKBundle", () => {
  it("summarizes each order for the page header", () => {
    const draft = normalizeKKBundle(bundle());
    expect(draft.orders).toEqual([
      { orderNumber: "0009900001", requiredDate: "8/1/26", itemCount: 2 },
      { orderNumber: "0009900002", requiredDate: "9/1/26", itemCount: 1 },
    ]);
  });

  it("flattens rows across orders in document order, each tagged with its owning order", () => {
    const draft = normalizeKKBundle(bundle());
    expect(draft.rows).toHaveLength(3);
    expect(draft.rows.map((r) => r.partNumber)).toEqual(["15668B", "90021D-NA", "17429A-TN"]);
    // The reference is what makes one bundle create several draft POs.
    expect(draft.rows.map((r) => r.reference)).toEqual(["0009900001", "0009900001", "0009900002"]);
  });

  it("maps an item to the HomeAccessoryExportRow shape", () => {
    const draft = normalizeKKBundle(bundle(), HOME_ACCESSORY_FORMATS[0]);
    const [row] = draft.rows;
    expect(row).toEqual({
      partNumber: "15668B",
      styleNumber: "15668B",
      productName: "13.5 Inch Brown Resin Horse",
      color: "",
      size: "",
      qty: 4,
      cost: 44.50,
      msrp: null,
      selling: null,
      department: "",
      category: "",
      supplier: "K & K Interiors",
      barcode: "842657186221",
      reference: "0009900001",
    });
  });

  it("uses the format's catalog vendor name when given", () => {
    const draft = normalizeKKBundle(bundle(), HOME_ACCESSORY_FORMATS[0]);
    expect(draft.vendorName).toBe("K & K Interiors");
  });

  it("falls back to the bundle's own vendor name when no format is given", () => {
    const draft = normalizeKKBundle(bundle({ vendorName: "Whatever The PDF Prints" }));
    expect(draft.vendorName).toBe("Whatever The PDF Prints");
  });

  it("carries customerPo and orderDate through from the bundle", () => {
    const draft = normalizeKKBundle(bundle());
    expect(draft.customerPo).toBe("PON00006");
    expect(draft.orderDate).toBe("Jun 15, 2026");
  });

  it("carries warnings through verbatim", () => {
    const warnings = [
      "Order 0009900001: calculated total $4,500.00 does not match printed total $4,500.01",
    ];
    const draft = normalizeKKBundle(bundle({ warnings }));
    expect(draft.warnings).toEqual(warnings);
  });
});

describe("percentage-based set splitting", () => {
  it("prefills the vendor's dominant shape: 40/35/25 for three, 62/38 for two", () => {
    expect(defaultSplitPercents(3)).toEqual([40, 35, 25]);
    expect(defaultSplitPercents(2)).toEqual([62, 38]);
    expect(SPLIT_PRESETS[3][0].percents).toEqual([40, 35, 25]);
    expect(SPLIT_PRESETS[2][0].percents).toEqual([62, 38]);
  });

  it("falls back to an even share where there's no dominant shape", () => {
    expect(defaultSplitPercents(4)).toEqual([25, 25, 25, 25]);
    expect(defaultSplitPercents(0)).toEqual([]);
  });

  it("allocates by percentage and always reconciles to the set price", () => {
    const costs = splitCostsByPercent(56.99, [40, 35, 25]);
    expect(costs).toEqual([22.79, 19.95, 14.25]);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(56.99, 2);
  });

  it("keeps the sum exact for every preset on awkward prices", () => {
    for (const price of [0.01, 10, 47.49, 56.99, 85.49, 199.99, 142.49]) {
      for (const parts of [2, 3]) {
        for (const preset of SPLIT_PRESETS[parts]) {
          const costs = splitCostsByPercent(price, preset.percents);
          expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(price, 2);
        }
      }
    }
  });

  it("does NOT silently normalise percentages that miss 100 — the shortfall stays visible", () => {
    const costs = splitCostsByPercent(100, [40, 35, 20]);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(95, 2);
  });

  it("reports a piece's share for display", () => {
    expect(costPercent(25.64, 56.99)).toBeCloseTo(44.99, 1);
    expect(costPercent(5, 0)).toBe(0);
  });
});

function wendoverItem(over: Partial<WendoverOrder["items"][number]> = {}) {
  return {
    sku: "WLD3511",
    name: "Before the Rain Customized",
    lineTotal: 1200,
    unitPrice: 400,
    qty: 3,
    medium: "Canvas",
    treatment: "Gallery Wrapped, Artist Enhanced",
    size: '35.01"w x 41.01"h',
    frame: "M1123, Antique Silver",
    sideMark: "",
    extras: [],
    ...over,
  };
}

function wendoverOrder(over: Partial<WendoverOrder> = {}): WendoverOrder {
  return {
    vendorName: "Wendover Art Group",
    orderNumber: "1000000001",
    orderDate: "Jul 13, 2026, 12:26:21 PM",
    printedSubtotal: 1200,
    items: [wendoverItem()],
    warnings: [],
    ...over,
  };
}

describe("wendoverDescription", () => {
  it("composes the labelled shape used for art", () => {
    expect(wendoverDescription(wendoverItem())).toBe(
      'Medium: Canvas Treatment: Gallery Wrapped, Artist Enhanced Size: 35.01"w x 41.01"h ' +
        "Frame: M1123, Antique Silver",
    );
  });

  it("appends the extra mat/liner lines the document carries", () => {
    const desc = wendoverDescription(wendoverItem({ extras: ["Bottom Mat: B97, Polar White"] }));
    expect(desc).toContain("Bottom Mat: B97, Polar White");
  });

  it("omits fields the document did not print", () => {
    expect(wendoverDescription(wendoverItem({ treatment: "", frame: "", extras: [] }))).toBe(
      'Medium: Canvas Size: 35.01"w x 41.01"h',
    );
  });
});

describe("normalizeWendoverOrder", () => {
  it("carries the DERIVED unit cost, never the printed line total", () => {
    const [row] = normalizeWendoverOrder(wendoverOrder()).rows;
    expect(row.cost).toBe(400);
    expect(row.qty).toBe(3);
  });

  it("leaves the part number bare for the page to prefix", () => {
    const [row] = normalizeWendoverOrder(wendoverOrder()).rows;
    expect(row.partNumber).toBe("WLD3511");
    expect(row.styleNumber).toBe("WLD3511");
  });

  it("leaves the barcode blank", () => {
    const [row] = normalizeWendoverOrder(wendoverOrder()).rows;
    expect(row.barcode).toBe("");
  });

  it("references every row to the order number so one draft PO is created", () => {
    const draft = normalizeWendoverOrder(wendoverOrder());
    expect(draft.rows.every((r) => r.reference === "1000000001")).toBe(true);
    expect(draft.orders).toEqual([{ orderNumber: "1000000001", requiredDate: "", itemCount: 1 }]);
  });

  it("prefers the registry's exact catalog vendor name", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "wendover");
    const draft = normalizeWendoverOrder(wendoverOrder({ vendorName: "wendover" }), format);
    expect(draft.vendorName).toBe("Wendover Art Group");
    expect(draft.rows[0].supplier).toBe("Wendover Art Group");
  });

  it("flags Side Mark items as already sold to a customer", () => {
    const draft = normalizeWendoverOrder(
      wendoverOrder({
        items: [wendoverItem({ sku: "WFL1944", sideMark: "SBOM41649/Dana Whitl" })],
      }),
    );
    expect(draft.warnings.some((w) => w.includes("SBOM41649/Dana Whitl"))).toBe(true);
    expect(draft.warnings.some((w) => w.includes("1 item(s) carry a Side Mark"))).toBe(true);
  });

  it("says nothing about side marks when none are printed", () => {
    expect(normalizeWendoverOrder(wendoverOrder()).warnings).toEqual([]);
  });

  it("carries the parser's own warnings through untouched", () => {
    const draft = normalizeWendoverOrder(wendoverOrder({ warnings: ["subtotal mismatch"] }));
    expect(draft.warnings).toContain("subtotal mismatch");
  });
});

function mtOrder(over: Partial<MarketTimeOrder> = {}): MarketTimeOrder {
  return {
    vendorName: "Graf & Lantz Inc",
    poNumber: "PON00004",
    orderDate: "06/11/2026",
    shipDate: "09/22/2026",
    printedSubtotal: 84,
    printedSkus: 1,
    printedUnits: 1,
    holdNote: "",
    items: [
      {
        itemNumber: "GL60BIN50FTLG",
        name: "Merino Wool Large Bin - Feather",
        upc: "840027244762",
        qty: 1,
        unitPrice: 84,
        lineTotal: 84,
        availability: "08/01/26",
      },
    ],
    warnings: [],
    ...over,
  };
}

describe("normalizeMarketTimeOrder", () => {
  it("takes the cost as printed — this vendor's Price IS the unit price", () => {
    const [row] = normalizeMarketTimeOrder(mtOrder()).rows;
    expect(row.cost).toBe(84);
    expect(row.qty).toBe(1);
  });

  it("carries the real manufacturer UPC", () => {
    const [row] = normalizeMarketTimeOrder(mtOrder()).rows;
    expect(row.barcode).toBe("840027244762");
  });

  it("leaves the part number bare for the page to prefix", () => {
    const [row] = normalizeMarketTimeOrder(mtOrder()).rows;
    expect(row.partNumber).toBe("GL60BIN50FTLG");
  });

  it("references every row to the PO number", () => {
    const draft = normalizeMarketTimeOrder(mtOrder());
    expect(draft.rows.every((r) => r.reference === "PON00004")).toBe(true);
    expect(draft.orders).toEqual([
      { orderNumber: "PON00004", requiredDate: "09/22/2026", itemCount: 1 },
    ]);
  });

  it("takes the supplier FROM THE DOCUMENT, so one entry serves every MarketTime vendor", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "market-time");
    const draft = normalizeMarketTimeOrder(
      mtOrder({ vendorName: "Some Other Vendor Inc" }),
      format,
    );
    expect(draft.vendorName).toBe("Some Other Vendor Inc");
    expect(draft.rows[0].supplier).toBe("Some Other Vendor Inc");
  });

  it("warns loudly when the document is a quote rather than an order", () => {
    const draft = normalizeMarketTimeOrder(
      mtOrder({ holdNote: "This is just a quote please hold" }),
    );
    expect(draft.warnings.some((w) => w.includes("quote or on hold"))).toBe(true);
    expect(draft.warnings.some((w) => w.includes("may not be a placed order"))).toBe(true);
  });

  it("says nothing about holds on an ordinary order", () => {
    expect(normalizeMarketTimeOrder(mtOrder()).warnings).toEqual([]);
  });

  it("carries the parser's own warnings through", () => {
    const draft = normalizeMarketTimeOrder(mtOrder({ warnings: ["subtotal mismatch"] }));
    expect(draft.warnings).toContain("subtotal mismatch");
  });
});

describe("normalizeBrandWiseOrder", () => {
  function bwOrder(over: Partial<BrandWiseOrder> = {}): BrandWiseOrder {
    return {
      salesOrderNo: "B31600001",
      poNumber: "PON00005",
      orderDate: "6/10/2026",
      shipDate: "8/24/2026",
      printedTotal: 800,
      items: [
        {
          sku: "IN-8222",
          name: "The Cadier Wooden Wall Mirrors",
          qty: 4,
          uom: "EA",
          unitPrice: 250,
          lineTotal: 1000,
        },
      ],
      warnings: [],
      ...over,
    };
  }

  it("takes the unit price as the cost and leaves the barcode blank", () => {
    const [row] = normalizeBrandWiseOrder(bwOrder()).rows;
    expect(row.cost).toBe(250);
    expect(row.barcode).toBe("");
    expect(row.partNumber).toBe("IN-8222");
  });

  it("defaults the supplier to Zodax and references the PO", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "brandwise-zodax");
    const draft = normalizeBrandWiseOrder(bwOrder(), format);
    expect(draft.vendorName).toBe("Zodax");
    expect(draft.rows[0].reference).toBe("PON00005");
    expect(draft.orders[0]).toMatchObject({ orderNumber: "PON00005", itemCount: 1 });
  });

  it("carries the parser's warnings through", () => {
    const draft = normalizeBrandWiseOrder(bwOrder({ warnings: ["total mismatch"] }));
    expect(draft.warnings).toContain("total mismatch");
  });
});

describe("normalizeAestheticMovementOrder", () => {
  function amOrder(over: Partial<AestheticMovementOrder> = {}): AestheticMovementOrder {
    return {
      vendorName: "Printworks",
      poNumber: "PON00003",
      shipDate: "October 01, 2026",
      printedTotal: 1200,
      printedItems: 2,
      printedUnits: 18,
      items: [
        {
          sku: "PW00689",
          name: "Classic - Tic Tac Toe",
          upc: "7350108174152",
          qty: 12,
          unitPrice: 25,
          lineTotal: 300,
        },
        {
          sku: "PW00821",
          name: "Reverra - Mahjong",
          upc: "",
          qty: 6,
          unitPrice: 126,
          lineTotal: 756,
        },
      ],
      warnings: [],
      ...over,
    };
  }

  it("takes the unit price as the cost and carries the manufacturer UPC", () => {
    const [row] = normalizeAestheticMovementOrder(amOrder()).rows;
    expect(row.cost).toBe(25);
    expect(row.barcode).toBe("7350108174152");
    expect(row.partNumber).toBe("PW00689");
  });

  it("leaves the barcode blank for an item that printed no UPC", () => {
    const draft = normalizeAestheticMovementOrder(amOrder());
    expect(draft.rows[1].barcode).toBe("");
  });

  it("reads the vendor from the document and references the PO", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "aesthetic-movement");
    const draft = normalizeAestheticMovementOrder(amOrder(), format);
    expect(draft.vendorName).toBe("Printworks");
    expect(draft.rows[0].reference).toBe("PON00003");
    expect(draft.orders[0]).toMatchObject({ orderNumber: "PON00003", itemCount: 2 });
  });

  it("carries the parser's warnings through", () => {
    const draft = normalizeAestheticMovementOrder(amOrder({ warnings: ["total mismatch"] }));
    expect(draft.warnings).toContain("total mismatch");
  });
});

describe("normalizeSuperCatOrder", () => {
  function scOrder(over: Partial<SuperCatOrder> = {}): SuperCatOrder {
    return {
      vendorName: "Dana Whitfield Company",
      orderNumber: "990001-070126-175-1",
      customerPo: "",
      orderDate: "7/1/26",
      shipDate: "8/11/26",
      printedSubtotal: 1260,
      orderDiscount: 0,
      items: [
        {
          itemNumber: "9BOATLINEG",
          name: "Boa Table Lamp",
          qty: 6,
          unitPrice: 210,
          lineTotal: 1260,
        },
      ],
      warnings: [],
      ...over,
    };
  }

  it("takes the unit price as the cost and leaves the barcode blank", () => {
    const [row] = normalizeSuperCatOrder(scOrder()).rows;
    expect(row.cost).toBe(210);
    expect(row.barcode).toBe("");
    expect(row.partNumber).toBe("9BOATLINEG");
  });

  it("reads the vendor from the document and references the order number", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "supercat");
    const draft = normalizeSuperCatOrder(scOrder(), format);
    expect(draft.vendorName).toBe("Dana Whitfield Company");
    expect(draft.rows[0].reference).toBe("990001-070126-175-1");
    expect(draft.orders[0]).toMatchObject({
      orderNumber: "990001-070126-175-1",
      itemCount: 1,
    });
  });

  it("carries the parser's discount warning through", () => {
    const draft = normalizeSuperCatOrder(scOrder({ warnings: ["order-level discount of 533.00"] }));
    expect(draft.warnings.some((w) => w.includes("order-level discount"))).toBe(true);
  });
});

describe("normalizeSimblistOrder", () => {
  function smOrder(over: Partial<SimblistOrder> = {}): SimblistOrder {
    return {
      vendorName: "MAISON ZOE FORD",
      repGroup: "Simblist Group",
      poNumber: "PON00001",
      orderDate: "2026-06-11",
      shipDate: "2026-09-01",
      printedTotal: 615.6,
      items: [
        {
          itemNumber: "ZFUSA03-C",
          name: "Big Time Brownie Mix - case pack of 6",
          qty: 2,
          unitPrice: 48,
          lineTotal: 96,
          upc: "10628678860152",
          listPrice: 15,
          notes: "Only available to ship on September 1, 2026",
        },
      ],
      warnings: [],
      ...over,
    };
  }

  it("takes the unit price as cost and carries the manufacturer UPC", () => {
    const [row] = normalizeSimblistOrder(smOrder()).rows;
    expect(row.cost).toBe(48);
    expect(row.barcode).toBe("10628678860152");
    expect(row.partNumber).toBe("ZFUSA03-C");
  });

  it("carries the ship-caveat note into the description", () => {
    const [row] = normalizeSimblistOrder(smOrder()).rows;
    expect(row.description).toBe("Only available to ship on September 1, 2026");
  });

  it("reads the vendor from the CSV and references the PO", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "maison-zoe-ford");
    const draft = normalizeSimblistOrder(smOrder(), format);
    expect(draft.vendorName).toBe("MAISON ZOE FORD");
    expect(draft.rows[0].reference).toBe("PON00001");
    expect(draft.orders[0]).toMatchObject({ orderNumber: "PON00001", itemCount: 1 });
  });

  it("carries the parser's discount warning through", () => {
    const draft = normalizeSimblistOrder(smOrder({ warnings: ["order-level discount of 80.30"] }));
    expect(draft.warnings.some((w) => w.includes("order-level discount"))).toBe(true);
  });
});

describe("normalizeBeatrizBallOrder", () => {
  function bbOrder(over: Partial<BeatrizBallOrder> = {}): BeatrizBallOrder {
    return {
      vendorName: "Beatriz Ball",
      orderNumber: "0090001",
      customerPo: "PON00002",
      orderDate: "6/10/2026",
      printedTotal: 226,
      items: [
        {
          itemCode: "3496",
          name: "GLASS Vento Medium Vase (Clear)",
          qty: 4,
          unitPrice: 18,
          lineTotal: 99,
          msrp: 45,
        },
        {
          itemCode: "6644",
          name: "Beatriz Ball metal placard",
          qty: 1,
          unitPrice: 0,
          lineTotal: 0,
          msrp: 0,
        },
      ],
      warnings: [],
      ...over,
    };
  }

  it("takes the wholesale unit price as cost and prefills retail from MSRP", () => {
    const [row] = normalizeBeatrizBallOrder(bbOrder()).rows;
    expect(row.cost).toBe(18);
    expect(row.msrp).toBe(45);
    expect(row.selling).toBe(45);
    expect(row.barcode).toBe("");
    expect(row.partNumber).toBe("3496");
  });

  it("leaves retail blank for a $0 line so the buyer decides", () => {
    const placard = normalizeBeatrizBallOrder(bbOrder()).rows[1];
    expect(placard.msrp).toBeNull();
    expect(placard.selling).toBeNull();
  });

  it("pins the supplier and references the customer PO", () => {
    const format = HOME_ACCESSORY_FORMATS.find((f) => f.id === "beatriz-ball");
    const draft = normalizeBeatrizBallOrder(bbOrder(), format);
    expect(draft.vendorName).toBe("Beatriz Ball");
    expect(draft.rows[0].reference).toBe("PON00002");
    expect(draft.orders[0]).toMatchObject({ orderNumber: "PON00002", itemCount: 2 });
  });

  it("carries the parser's warnings through", () => {
    const draft = normalizeBeatrizBallOrder(bbOrder({ warnings: ["net mismatch"] }));
    expect(draft.warnings).toContain("net mismatch");
  });
});

describe("sameSupplier — & vs and tolerance", () => {
  it("matches the document's '&' spelling to a catalog's 'and'", () => {
    expect(sameSupplier("Simon & Schuster", "Simon and Schuster")).toBe(true);
    expect(sameSupplier("SIMON AND SCHUSTER", "simon & schuster")).toBe(true);
  });

  it("still matches a vendor genuinely stored with '&'", () => {
    expect(sameSupplier("Graf & Lantz Inc", "Graf & Lantz Inc")).toBe(true);
    expect(sameSupplier("Graf and Lantz Inc", "Graf & Lantz Inc")).toBe(true);
  });

  it("does not match different vendors", () => {
    expect(sameSupplier("Simon and Schuster", "Zodax")).toBe(false);
    expect(sameSupplier("Graphique de France", "Graf & Lantz Inc")).toBe(false);
  });

  it("normalizes case, ampersand, and whitespace", () => {
    expect(normalizeSupplier("  Simon  &   Schuster ")).toBe("simon and schuster");
  });
});
