// /app/__tests__/marketTimeOrderParser.test.ts
//
// The fixture is the real Harper Group / MarketTime PO for Graf & Lantz
// (PON09057, 06/11/2026, 11 SKUs / 73 units / $2,196.00), condensed.

import { parseMarketTimeOrderText, splitUpcPriceTotal } from "@/lib/pricing/marketTimeOrderParser";

const FIXTURE = [
  "Purchase Order by  - ID# 31680534MarketTime",
  " Season/Program:",
  " 06/11/2026Order Date:", // value BEFORE the label
  " Ship Date:09/22/2026", // value AFTER the label
  "Special Instructions: This is just a quote please hold",
  "PON09057",
  "PO #",
  "Graf & Lantz Inc",
  "QtyImageItem #NameUPCPriceUQUOMTotal",
  "1GL60BIN50FTLG",
  "Merino Wool Large Bin - Feather ",
  "(Avail:08/01/26)",
  "84002724476284.00$84.00",
  "6GL70TECH10GN16IN",
  'Merino Wool 16" Laptop Computer ',
  "Sleeve - Granite V (Avail:07/10/26)",
  "84002724051149.00$294.00",
  "PO # PON09057 (cont'd)Cust #MFR: Graf & Lantz IncCustomer: Saybrook Home",
  "    Page  of 22",
  "10GL10WINO10-12AUTU",
  "Wine-O's Merino Wool Round Wine ",
  "Markers - Autumn (Avail:06/08/26)",
  "84002720301112.00$120.00",
  "3 Skus | 17 Units",
  "$498.00",
  "$0.00",
  "$498.00",
  "Sub Total:",
].join("\n");

describe("splitUpcPriceTotal — the concatenation trap", () => {
  it("uses the arithmetic to settle where the UPC ends", () => {
    // "84002724476284.00$84.00" has NO separator. A greedy digit match reads a
    // 13-digit UPC and leaves "4.00" as the price — a silent 20x cost error
    // that still parses cleanly. qty x price == total is the only thing that
    // can tell the readings apart.
    expect(splitUpcPriceTotal("84002724476284.00$84.00", 1)).toEqual({
      upc: "840027244762",
      unitPrice: 84,
      lineTotal: 84,
    });
  });

  it("refuses rather than guessing when no reading reconciles", () => {
    // Same line, wrong quantity: neither the 12- nor the 13-digit reading
    // satisfies the arithmetic, so it reports instead of picking one.
    expect(splitUpcPriceTotal("84002724476284.00$84.00", 5)).toBeNull();
  });

  it("splits a multi-unit line correctly", () => {
    expect(splitUpcPriceTotal("84002724051149.00$294.00", 6)).toEqual({
      upc: "840027240511",
      unitPrice: 49,
      lineTotal: 294,
    });
  });

  it("handles a comma in the money", () => {
    expect(splitUpcPriceTotal("840027244762100.00$1,200.00", 12)).toEqual({
      upc: "840027244762",
      unitPrice: 100,
      lineTotal: 1200,
    });
  });

  it("returns null on a line that is not a price line at all", () => {
    expect(splitUpcPriceTotal("Merino Wool Large Bin - Feather", 1)).toBeNull();
  });
});

describe("parseMarketTimeOrderText", () => {
  const order = parseMarketTimeOrderText(FIXTURE);

  it("reads the header, including labels on either side of their value", () => {
    // Order Date prints "06/11/2026Order Date:" while Ship Date prints
    // "Ship Date:09/22/2026" — right- vs left-aligned cells. Handling only one
    // direction leaves the other silently blank.
    expect(order.poNumber).toBe("PON09057");
    expect(order.orderDate).toBe("06/11/2026");
    expect(order.shipDate).toBe("09/22/2026");
  });

  it("finds the manufacturer mid-line in the run-together page header", () => {
    // "...(cont'd)Cust #MFR: Graf & Lantz IncCustomer: Saybrook Home" — and
    // that line is dropped by the item pass's page-furniture filter, so the
    // header is read before filtering.
    expect(order.vendorName).toBe("Graf & Lantz Inc");
  });

  it("flags a document that is a quote rather than a placed order", () => {
    expect(order.holdNote).toBe("This is just a quote please hold");
  });

  it("treats Price as the UNIT price and Total as the extension", () => {
    // The OPPOSITE of Wendover. Getting it backwards multiplies or divides
    // every cost by the quantity.
    const sleeve = order.items.find((i) => i.itemNumber === "GL70TECH10GN16IN");
    expect(sleeve?.qty).toBe(6);
    expect(sleeve?.unitPrice).toBe(49);
    expect(sleeve?.lineTotal).toBe(294);
  });

  it("splits the concatenated qty and item number", () => {
    expect(order.items.map((i) => i.itemNumber)).toEqual([
      "GL60BIN50FTLG",
      "GL70TECH10GN16IN",
      "GL10WINO10-12AUTU",
    ]);
    expect(order.items.map((i) => i.qty)).toEqual([1, 6, 10]);
  });

  it("keeps the manufacturer UPC — this vendor prints real ones", () => {
    expect(order.items[0].upc).toBe("840027244762");
    expect(order.items.every((i) => /^\d{12}$/.test(i.upc))).toBe(true);
  });

  it("lifts the availability marker out of the product name", () => {
    // "(Avail:08/01/26)" is order information; it would otherwise ship to
    // Ordorite inside every item name.
    expect(order.items[0].name).toBe("Merino Wool Large Bin - Feather");
    expect(order.items[0].availability).toBe("08/01/26");
    expect(order.items.every((i) => !i.name.includes("Avail"))).toBe(true);
  });

  it("joins a wrapped name across lines", () => {
    expect(order.items[1].name).toBe('Merino Wool 16" Laptop Computer Sleeve - Granite V');
  });

  it("reconciles against the printed SKU, unit and money totals", () => {
    expect(order.warnings).toEqual([]);
    expect(order.printedSkus).toBe(3);
    expect(order.printedUnits).toBe(17);
    expect(order.printedSubtotal).toBe(498);
    expect(order.items.reduce((s, i) => s + i.lineTotal, 0)).toBeCloseTo(498, 2);
    expect(order.items.reduce((s, i) => s + i.qty, 0)).toBe(17);
  });

  it("warns when the counts do not match what the document printed", () => {
    const short = parseMarketTimeOrderText(
      ["1GL60BIN50FTLG", "A bin", "84002724476284.00$84.00", "9 Skus | 99 Units"].join("\n"),
    );
    expect(short.warnings.some((w) => w.includes("9 SKUs"))).toBe(true);
    expect(short.warnings.some((w) => w.includes("99 units"))).toBe(true);
  });

  it("warns rather than dropping an item whose price line never parses", () => {
    const broken = parseMarketTimeOrderText(
      ["1GL60BIN50FTLG", "A bin", "not-a-price-line", "6GL70TECH10GN16IN"].join("\n"),
    );
    expect(broken.warnings.some((w) => w.includes("GL60BIN50FTLG"))).toBe(true);
  });

  it("says nothing about holds on an ordinary order", () => {
    const plain = parseMarketTimeOrderText(
      ["PON09999", "1GL60BIN50FTLG", "A bin", "84002724476284.00$84.00"].join("\n"),
    );
    expect(plain.holdNote).toBe("");
    expect(plain.warnings).toEqual([]);
  });
});

describe("parseMarketTimeOrderText — the UQ/UOM + numeric-item variants", () => {
  // Other MarketTime vendors print UQ/UOM columns in the money line and, for
  // book vendors (Simon & Schuster via Anne McGilvray), use the ISBN as the
  // item number — sometimes with the whole block concatenated onto one line.
  // Verified against the real orders (Graphique SO9939511, Anne McGilvray
  // PON09059) before these fixtures were condensed from them.

  it("reads a money line with UQ + UOM between the price and the total", () => {
    // "...7.50" + "1EACH" + "$90.00" — the Graf & Lantz dialect had neither.
    // The 13-digit UPC wins because a 12-digit read leaves "27.50", and
    // 12 x 27.50 != 90 (the arithmetic rejects it).
    expect(splitUpcPriceTotal("97814770663627.501EACH$90.00", 12)).toEqual({
      upc: "9781477066362",
      unitPrice: 7.5,
      lineTotal: 90,
    });
  });

  it("parses Graphique's letter items with the UOM money line", () => {
    const order = parseMarketTimeOrderText(
      [
        "PON09999",
        "You will receive an invoice from Graphique de France",
        "12BXX805",
        "Trees Holiday Boxed Cards (Avail:01/01/26)",
        "97814770663627.501EACH$90.00",
        "$90.00",
        "Sub Total:",
      ].join("\n"),
    );
    expect(order.vendorName).toBe("Graphique de France");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      itemNumber: "BXX805",
      qty: 12,
      unitPrice: 7.5,
      lineTotal: 90,
      availability: "01/01/26",
    });
  });

  it("splits a numeric ISBN item spread across lines using its money UPC", () => {
    const order = parseMarketTimeOrderText(
      [
        "PON09999",
        "You will receive an invoice from Simon & Schuster",
        "129781788792110",
        "SHARE: DELICIOUS SHARING BOARDS FOR SOCIAL DINING",
        "978178879211019.95EA$239.40",
      ].join("\n"),
    );
    expect(order.vendorName).toBe("Simon & Schuster");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      itemNumber: "9781788792110",
      qty: 12,
      unitPrice: 19.95,
      lineTotal: 239.4,
      name: "SHARE: DELICIOUS SHARING BOARDS FOR SOCIAL DINING",
    });
  });

  it("parses a fully-concatenated ISBN item, keeping the 13-digit ISBN and a clean name", () => {
    // The whole block arrives on one line, and the ISBN reappears as the money
    // UPC: "12" + ISBN + "BITES ON A BOARD" + ISBN + "26.99" + "EA" + "$323.88".
    // A 12-digit reading also reconciles on price but steals the ISBN's last
    // digit into the name — the longest valid UPC is the right one.
    const order = parseMarketTimeOrderText(
      "129781423645740BITES ON A BOARD978142364574026.99EA$323.88",
    );
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      itemNumber: "9781423645740",
      qty: 12,
      unitPrice: 26.99,
      lineTotal: 323.88,
      name: "BITES ON A BOARD",
    });
  });

  it("still parses Graf & Lantz's simpler dialect (no UQ/UOM, letter items)", () => {
    // Regression guard: the extension must not disturb the original format.
    const order = parseMarketTimeOrderText(
      ["PON09057", "1GL60BIN50FTLG", "Merino Wool Large Bin", "84002724476284.00$84.00"].join("\n"),
    );
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ itemNumber: "GL60BIN50FTLG", qty: 1, unitPrice: 84 });
  });

  it("falls back to the MarketTime order id when a document carries no buyer PON", () => {
    // ACC Art Books prints "ID# 32008813" instead of a PON — the reference must
    // not come out blank.
    const order = parseMarketTimeOrderText(
      [
        "Purchase Order by  - ID# 32008813MarketTime",
        "You will receive an invoice from ACC Art Books",
        "9782875501417",
        "SENSE OF STYLE",
        "978287550141786.00$688.00",
      ].join("\n"),
    );
    expect(order.poNumber).toBe("32008813");
    expect(order.vendorName).toBe("ACC Art Books");
  });

  it("prefers a real PON over the order-id fallback", () => {
    const order = parseMarketTimeOrderText(
      [
        "Purchase Order by  - ID# 32008813MarketTime",
        "PON09057",
        "1GL60BIN50FTLG",
        "Merino Wool Large Bin",
        "84002724476284.00$84.00",
      ].join("\n"),
    );
    expect(order.poNumber).toBe("PON09057");
  });
});
