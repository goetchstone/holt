// /app/__tests__/apparelOrderVendors.test.ts
//
// Pins the vendor-format registry and the normalizers that turn parsed
// NuOrder / Z Supply / Frank & Eileen / generic-CSV orders into
// ApparelOrderRow[] for the Apparel Order Import tool. Ported from
// furniture-configurator's apparelOrderVendors.test.ts, with the
// catalog-matching-only tests (pickBestCatalogRows / groupStyleCandidates
// / rankColorSuggestions / ordoriteId) dropped -- holt's Buyer Drafts
// domain has no catalog-matching step (see lib/apparelOrderVendors.ts
// header comment).

import {
  APPAREL_VENDOR_FORMATS,
  CSV_COLUMN_ALIASES,
  partNumberForRow,
  normalizeNuOrder,
  normalizeNuOrderPrintout,
  stripStyleHyphens,
  normalizeZSupply,
  normalizeFrankEileen,
  normalizeCsvRows,
  frankEileenRetail,
  titleCaseColor,
  titleCaseVendorText,
  buildPrefixedPartNumber,
  extractSizeAndColor,
  leadingColorCode,
} from "@/lib/apparelOrderVendors";
import type { NuOrderPO } from "@/lib/pricing/nuorderParser";
import type { NuOrderPrintout } from "@/lib/pricing/nuorderPrintoutParser";
import type { ZSupplyInvoice } from "@/lib/pricing/zSupplyParser";
import type { FrankEileenOrder } from "@/lib/pricing/frankEileenParser";

describe("registry", () => {
  it("pins the format ids, file types, and parser dispatch", () => {
    expect(APPAREL_VENDOR_FORMATS.map((f) => [f.id, f.accepts, f.parser])).toEqual([
      ["rails", "pdf", "nuorder"],
      ["rag-bone", "pdf", "nuorder"],
      ["faherty", "pdf", "nuorder"],
      ["favorite-daughter", "pdf", "nuorder"],
      ["vineyard-vines", "pdf", "nuorder"],
      ["nic-zoe", "pdf", "nuorder"],
      ["hunter-bell", "pdf", "nuorder-printout"],
      ["pistola", "pdf", "nuorder-printout"],
      ["nuorder-printout", "pdf", "nuorder-printout"],
      ["nuorder", "pdf", "nuorder"],
      ["zsupply", "pdf", "zsupply"],
      ["frank-eileen", "pdf", "frank-eileen"],
      ["generic-csv", "csv", null],
    ]);
  });

  it("pins the part-number prefixes", () => {
    const byId = Object.fromEntries(APPAREL_VENDOR_FORMATS.map((f) => [f.id, f]));
    expect(byId["rails"].partNumberPrefix).toBe("RAI");
    expect(byId["rag-bone"].partNumberPrefix).toBe("RB");
    expect(byId["rag-bone"].catalogVendorName).toBe("Rag-Bone");
    expect(byId["faherty"].partNumberPrefix).toBe("FTY");
    expect(byId["favorite-daughter"].partNumberPrefix).toBe("FVDR");
    expect(byId["vineyard-vines"].partNumberPrefix).toBe("VV");
    expect(byId["nic-zoe"].partNumberPrefix).toBe("NZ");
    expect(byId["frank-eileen"].partNumberPrefix).toBe("FAE");
    expect(byId["zsupply"].partNumberPrefix).toBe("ZSP");
    expect(byId["zsupply"].catalogVendorName).toBe("Z Supply");
    expect(byId["nuorder"].partNumberPrefix).toBeUndefined();
    // Holt adaptation: no Vendor.partNumberPrefix DB column, so these two
    // known vendors' prefixes are hardcoded in the registry (values
    // carried over verbatim from FC's DB-seeded prefixes).
    expect(byId["hunter-bell"].partNumberPrefix).toBe("HBEL");
    expect(byId["hunter-bell"].catalogVendorName).toBe("Hunter Bell");
    expect(byId["pistola"].partNumberPrefix).toBe("PST");
    expect(byId["pistola"].catalogVendorName).toBe("Pistola");
    expect(byId["pistola"].normalizeStyleNumber).toBe(stripStyleHyphens);
    // The unbranded catch-all entries carry no prefix -- buyer edits the
    // Part # column in the preview when needed.
    expect(byId["nuorder-printout"].partNumberPrefix).toBeUndefined();
    expect(byId["nuorder-printout"].catalogVendorName).toBeUndefined();
  });

  it("keeps the UPC aliases the wholesale import path also relies on", () => {
    expect(CSV_COLUMN_ALIASES.upc).toEqual(
      expect.arrayContaining(["UPC", "Barcode", "EAN", "GTIN"]),
    );
    expect(CSV_COLUMN_ALIASES.retail).toEqual(expect.arrayContaining(["Retail", "MSRP"]));
  });
});

function nuOrderFixture(): NuOrderPO {
  return {
    vendorName: "Favorite Daughter",
    orderNumber: "SO-99120",
    poNumber: "PO-84421",
    orderDate: "07/01/2026",
    deliveryStart: "08/01/2026",
    deliveryEnd: "08/15/2026",
    terms: "Net 30",
    buyerName: "Buyer",
    buyerEmail: "buyer@saybrookhome.com",
    totalUnits: 4,
    totalPrice: 154,
    items: [
      {
        productName: "Slub Rib Tee",
        styleNumber: "FD1234",
        msrp: 98,
        season: "FALL 26",
        color: "Black",
        colorCode: "BLK",
        unitPrice: 38.5,
        totalUnits: 3,
        totalPrice: 115.5,
        sizes: [
          { size: "M", quantity: 2 },
          { size: "L", quantity: 1 },
        ],
      },
      {
        productName: "Silk Scarf",
        styleNumber: "FD9000",
        msrp: 0,
        season: "",
        color: "Ivory",
        colorCode: "IVY",
        unitPrice: 38.5,
        totalUnits: 1,
        totalPrice: 38.5,
        sizes: [],
      },
    ],
  };
}

describe("normalizeNuOrder", () => {
  it("flattens per-size breakdowns into one row per size with that size's qty", () => {
    const draft = normalizeNuOrder(nuOrderFixture());
    expect(draft.rows).toHaveLength(3);
    expect(draft.rows[0].partNumber).toBe("FD1234-BLK-M");
    expect(draft.rows[0].qty).toBe(2);
    expect(draft.rows[1].partNumber).toBe("FD1234-BLK-L");
    expect(draft.rows[1].qty).toBe(1);
  });

  it("sizeless items keep the bare style number", () => {
    const scarf = normalizeNuOrder(nuOrderFixture()).rows[2];
    expect(scarf.partNumber).toBe("FD9000");
    expect(scarf.size).toBe("");
    expect(scarf.qty).toBe(1);
  });

  it("selling defaults to MSRP; zero MSRP normalizes to null", () => {
    const rows = normalizeNuOrder(nuOrderFixture()).rows;
    expect(rows[0].msrp).toBe(98);
    expect(rows[0].selling).toBe(98);
    expect(rows[2].msrp).toBeNull();
    expect(rows[2].selling).toBeNull();
  });

  it("carries season and the vendor as supplier", () => {
    const draft = normalizeNuOrder(nuOrderFixture());
    expect(draft.season).toBe("FALL 26");
    expect(draft.rows[0].season).toBe("FALL 26");
    expect(draft.rows[0].supplier).toBe("Favorite Daughter");
  });

  it("uses the registry's prefix + catalog vendor name when given a format entry", () => {
    const format = APPAREL_VENDOR_FORMATS.find((f) => f.id === "faherty")!;
    const draft = normalizeNuOrder(nuOrderFixture(), format);
    expect(draft.vendorName).toBe("Faherty");
    expect(draft.rows[0].partNumber).toBe("FTY-FD1234-M-Black");
  });
});

function nuOrderPrintoutFixture(): NuOrderPrintout {
  return {
    vendorName: "",
    poNumber: "PO-18908185",
    orderDate: "06/01/2026",
    deliveryStart: "07/01/2026",
    deliveryEnd: "08/01/2026",
    terms: "Net 30",
    season: "Fall 2026",
    totalUnits: 3,
    totalPrice: 100,
    warnings: [],
    cancelled: { items: 0, units: 0, total: 0 },
    items: [
      {
        styleNumber: "P00051000-MK",
        colorCode: "PRBG Pink Red Blue Flowers",
        productName: "cabana towel terry surf stripe polo",
        msrp: 50,
        unitPrice: 25,
        totalUnits: 3,
        totalPrice: 75,
        sizes: [
          { size: "S", quantity: 2 },
          { size: "O/S", quantity: 1 },
        ],
      },
    ],
  };
}

describe("normalizeNuOrderPrintout", () => {
  it("maps O/S to the catalog's OS suffix and titles-cases the product name", () => {
    const draft = normalizeNuOrderPrintout(nuOrderPrintoutFixture());
    expect(draft.rows[1].size).toBe("OS");
    expect(draft.rows[0].productName).toBe("Cabana Towel Terry Surf Stripe Polo");
  });

  it("pulls the leading color code and applies the pistola hyphen-strip + prefix", () => {
    const format = APPAREL_VENDOR_FORMATS.find((f) => f.id === "pistola")!;
    const draft = normalizeNuOrderPrintout(nuOrderPrintoutFixture(), format);
    expect(draft.vendorName).toBe("Pistola");
    expect(draft.rows[0].color).toBe("PRBG");
    expect(draft.rows[0].colorCode).toBe("PRBG");
    // stripStyleHyphens("P00051000-MK") -> "P00051000MK"
    expect(draft.rows[0].partNumber).toBe("PST-P00051000MK-S-PRBG");
  });

  it("applies the hunter-bell prefix without a style rewrite", () => {
    const format = APPAREL_VENDOR_FORMATS.find((f) => f.id === "hunter-bell")!;
    const fixture = nuOrderPrintoutFixture();
    fixture.items[0].colorCode = "1984 Washed Blue";
    const draft = normalizeNuOrderPrintout(fixture, format);
    expect(draft.rows[0].color).toBe("1984");
    expect(draft.rows[0].partNumber).toBe("HBEL-P00051000-MK-S-1984");
  });

  it("falls back to an unprefixed scheme with no format entry", () => {
    const draft = normalizeNuOrderPrintout(nuOrderPrintoutFixture());
    expect(draft.rows[0].partNumber).toBe("P00051000-MK-S");
  });

  it("keeps a code-less color name, title-cased when the cell is ALL CAPS", () => {
    // "WASHED" is 6 letters -- too long to match the 2-4 char leading-code
    // pattern, so this cell has no code and falls to the title-case branch.
    const fixture = nuOrderPrintoutFixture();
    fixture.items[0].colorCode = "WASHED INDIGO BLUE";
    const draft = normalizeNuOrderPrintout(fixture);
    expect(draft.rows[0].color).toBe("Washed Indigo Blue");
  });

  it("appends a cancelled-styles warning when the printout carries one", () => {
    const fixture = nuOrderPrintoutFixture();
    fixture.cancelled = { items: 2, units: 5, total: 250 };
    const draft = normalizeNuOrderPrintout(fixture);
    expect(draft.warnings).toEqual(["2 cancelled style(s) excluded: 5 units, $250.00"]);
  });
});

describe("normalizeZSupply", () => {
  function fixture(): ZSupplyInvoice {
    return {
      vendorName: "Z Supply",
      invoiceNumber: "INV-5521",
      orderNumber: "",
      poNumber: "PO-231",
      invoiceDate: "07/01/2026",
      dueDate: "08/01/2026",
      terms: "Net 30",
      shipVia: "UPS",
      trackingNumber: "1Z999",
      totalUnits: 3,
      totalPrice: 90,
      items: [
        {
          styleNumber: "ZT251",
          colorCode: "WHT",
          productName: "Pocket Tee",
          size: "S",
          quantity: 2,
          unitPrice: 30,
          extendedAmount: 60,
        },
        {
          styleNumber: "ZH100",
          colorCode: "BLK",
          productName: "Beanie",
          size: "",
          quantity: 1,
          unitPrice: 30,
          extendedAmount: 30,
        },
      ],
    };
  }

  it("uses the OS fallback for sizeless rows with no format entry", () => {
    const rows = normalizeZSupply(fixture()).rows;
    expect(rows[0].partNumber).toBe("ZT251-WHT-S");
    expect(rows[1].partNumber).toBe("ZH100-BLK-OS");
    expect(rows[1].size).toBe("OS");
  });

  it("keys rows to the ZSP-STYLE-SIZE-Color scheme with the registry entry", () => {
    const format = APPAREL_VENDOR_FORMATS.find((f) => f.id === "zsupply")!;
    const draft = normalizeZSupply(fixture(), format);
    expect(draft.rows[0].partNumber).toBe("ZSP-ZT251-S-WHT");
    expect(draft.rows[0].color).toBe("WHT");
    expect(draft.rows[1].partNumber).toBe("ZSP-ZH100-OS-BLK");
    expect(draft.vendorName).toBe("Z Supply");
    expect(draft.rows[0].supplier).toBe("Z Supply");
  });

  it("invoices carry no MSRP -- msrp/selling stay null for manual entry", () => {
    const rows = normalizeZSupply(fixture()).rows;
    expect(rows[0].msrp).toBeNull();
    expect(rows[0].selling).toBeNull();
  });

  it("falls back to the invoice number when there is no order number", () => {
    expect(normalizeZSupply(fixture()).orderNumber).toBe("INV-5521");
  });
});

function frankEileenFixture(): FrankEileenOrder {
  return {
    vendorName: "Frank and Eileen",
    ackNumber: "ACK-1001",
    poNumber: "PO-99",
    orderDate: "06/01/2026",
    deliveryStart: "07/01/2026",
    deliveryEnd: "08/01/2026",
    season: "Spring 2026",
    totalUnits: 2,
    totalPrice: 200,
    warnings: [],
    items: [
      {
        styleNumber: "EILEEN",
        colorCode: "PRBG",
        description: "relaxed button-up shirt",
        unitPrice: 99,
        totalUnits: 2,
        totalPrice: 198,
        sizes: [
          { size: "M", quantity: 1 },
          { size: "O/S", quantity: 1 },
        ],
      },
    ],
  };
}

describe("normalizeFrankEileen", () => {
  it("always uses the FAE prefix and maps O/S to OS", () => {
    const draft = normalizeFrankEileen(frankEileenFixture());
    expect(draft.rows[0].partNumber).toBe("FAE-EILEEN-M-PRBG");
    expect(draft.rows[1].partNumber).toBe("FAE-EILEEN-OS-PRBG");
    expect(draft.rows[1].size).toBe("OS");
  });

  it("re-cases the vendor's lower-case description", () => {
    const draft = normalizeFrankEileen(frankEileenFixture());
    expect(draft.rows[0].productName).toBe("Relaxed Button-Up Shirt");
  });

  it("prefills selling from the frankEileenRetail formula, not MSRP (there is none)", () => {
    const draft = normalizeFrankEileen(frankEileenFixture());
    expect(draft.rows[0].msrp).toBeNull();
    expect(draft.rows[0].selling).toBe(228); // cost 99 * 2.3 = 227.7 -> nearest ...8 is 228
  });

  it("carries the ack number as the order number and passes through warnings", () => {
    const fixture = frankEileenFixture();
    fixture.warnings = ["dropped a block: qty mismatch"];
    const draft = normalizeFrankEileen(fixture);
    expect(draft.orderNumber).toBe("ACK-1001");
    expect(draft.warnings).toEqual(["dropped a block: qty mismatch"]);
  });
});

describe("frankEileenRetail", () => {
  it("pins the documented markup table", () => {
    expect(frankEileenRetail(99)).toBe(228);
    expect(frankEileenRetail(104)).toBe(238);
    expect(frankEileenRetail(112)).toBe(258);
    expect(frankEileenRetail(116)).toBe(268);
    expect(frankEileenRetail(143)).toBe(328);
    expect(frankEileenRetail(151)).toBe(348);
    expect(frankEileenRetail(173)).toBe(398);
  });

  it("returns null for non-positive or non-finite cost", () => {
    expect(frankEileenRetail(0)).toBeNull();
    expect(frankEileenRetail(-5)).toBeNull();
    expect(frankEileenRetail(Number.NaN)).toBeNull();
  });
});

describe("titleCaseColor / buildPrefixedPartNumber", () => {
  it("title-cases across spaces, slashes, and dashes", () => {
    expect(titleCaseColor("SALINO STRIPE")).toBe("Salino Stripe");
    expect(titleCaseColor("washed black")).toBe("Washed Black");
    expect(titleCaseColor("black/khaki")).toBe("Black/Khaki");
  });

  it("builds PREFIX-STYLE-SIZE-Color with the color AS TYPED", () => {
    expect(buildPrefixedPartNumber("FTY", "MBU2411", "S", "Washed Black")).toBe(
      "FTY-MBU2411-S-Washed Black",
    );
    expect(buildPrefixedPartNumber("FAE", "EILEEN", "L", "NYAR Sail Boats")).toBe(
      "FAE-EILEEN-L-NYAR Sail Boats",
    );
  });
});

describe("titleCaseVendorText", () => {
  it("re-cases names the vendor shouted", () => {
    expect(titleCaseVendorText("CLARENDON SLEEK STRETCH CUFFED ANKLE PANT")).toBe(
      "Clarendon Sleek Stretch Cuffed Ankle Pant",
    );
  });

  it("leaves deliberately-cased text alone", () => {
    expect(titleCaseVendorText("Relaxed Button-Up Shirt")).toBe("Relaxed Button-Up Shirt");
    expect(titleCaseVendorText("NYAR Sail Boats")).toBe("NYAR Sail Boats");
  });

  it("keeps acronyms and digit-bearing tokens inside an ALL-CAPS string", () => {
    expect(titleCaseVendorText("NYC TROUSER")).toBe("NYC Trouser");
    expect(titleCaseVendorText("2PC PAJAMA SET")).toBe("2PC Pajama Set");
  });

  it("passes blanks straight through", () => {
    expect(titleCaseVendorText("")).toBe("");
    expect(titleCaseVendorText("   ")).toBe("   ");
  });
});

describe("partNumberForRow", () => {
  const row = {
    partNumber: "MBU2411-wbk-S",
    styleNumber: "MBU2411",
    size: "S",
    color: "Washed Black",
  };

  it("uses the prefixed scheme when a prefix is known", () => {
    expect(partNumberForRow(row, "FTY")).toBe("FTY-MBU2411-S-Washed Black");
  });

  it("keeps the normalizer's part number when no prefix exists", () => {
    expect(partNumberForRow(row)).toBe("MBU2411-wbk-S");
  });
});

describe("extractSizeAndColor / leadingColorCode / stripStyleHyphens", () => {
  it("splits a part number back into size + color", () => {
    expect(extractSizeAndColor("FAE-EILEEN-XS-Gold Multi Dot Black", "FAE", "EILEEN")).toEqual({
      size: "XS",
      color: "Gold Multi Dot Black",
    });
  });

  it("returns null when the part number doesn't match the prefix+style shape", () => {
    expect(extractSizeAndColor("OTHER-EILEEN-XS-Black", "FAE", "EILEEN")).toBeNull();
    expect(extractSizeAndColor("FAE-EILEEN-XS", "FAE", "EILEEN")).toBeNull();
  });

  it("finds a leading 2-4 char color code, else null", () => {
    expect(leadingColorCode("PRBG Pink Red Blue Flowers")).toBe("PRBG");
    expect(leadingColorCode("1984 Washed Blue")).toBe("1984");
    expect(leadingColorCode("Lost At Sea")).toBeNull();
  });

  it("strips every hyphen from a style number", () => {
    expect(stripStyleHyphens("P00051000-MK")).toBe("P00051000MK");
    expect(stripStyleHyphens("A-B-C")).toBe("ABC");
  });
});

describe("normalizeCsvRows", () => {
  it("maps aliased columns and skips rows with no style/SKU", () => {
    const result = normalizeCsvRows([
      {
        Vendor: "Rails",
        Style: "RC5726",
        "Product Name": "tank top",
        Qty: "5",
        Cost: "20",
        MSRP: "50",
        Color: "Lagoon",
        Size: "XS",
      },
      { Vendor: "Rails", Qty: "1" }, // no style -> skipped
    ]);
    expect(result.skipped).toBe(1);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.partNumber).toBe("RC5726-Lagoon-XS");
    expect(row.productName).toBe("Tank Top");
    expect(row.qty).toBe(5);
    expect(row.cost).toBe(20);
    expect(row.msrp).toBe(50);
    expect(row.selling).toBe(50);
    expect(row.supplier).toBe("Rails");
  });

  it("defaults qty to 1 and cost to 0 when blank/non-numeric", () => {
    const result = normalizeCsvRows([{ Style: "ABC123" }]);
    expect(result.rows[0].qty).toBe(1);
    expect(result.rows[0].cost).toBe(0);
    expect(result.rows[0].msrp).toBeNull();
  });

  it("inherits the first-seen vendor for rows without their own vendor column", () => {
    const result = normalizeCsvRows([{ Vendor: "Faherty", Style: "A1" }, { Style: "A2" }]);
    expect(result.rows[1].supplier).toBe("Faherty");
    expect(result.vendorNames).toEqual(["Faherty"]);
  });

  it("reports every distinct vendor name seen, for the mixed-vendor warning", () => {
    const result = normalizeCsvRows([
      { Vendor: "Faherty", Style: "A1" },
      { Vendor: "Rails", Style: "B1" },
    ]);
    expect(result.vendorNames).toEqual(["Faherty", "Rails"]);
  });
});
