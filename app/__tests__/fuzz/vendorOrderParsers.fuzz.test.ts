// /app/__tests__/fuzz/vendorOrderParsers.fuzz.test.ts
//
// Mutation-based fuzzing of the vendor order parsers in lib/pricing/: the text
// pulled out of a vendor's PDF (or CSV) becomes PO lines with a quantity and a
// dealer cost. Each parser starts from a short seed document in its own
// format (lines from its fixtures, data invented); the generator in support.ts
// deletes, duplicates and inserts lines and swaps digit runs for hostile
// numerals (400- and 308-digit runs, "Infinity", "-Infinity", "1e999").
// Properties:
//   - the unmutated seed yields at least one item, so the number reads are
//     reached and the other properties are not vacuous;
//   - never throws;
//   - every number in the result is finite -- an Infinity or NaN cost must
//     never reach a purchase order;
//   - a line holding a number of 300 or more digits puts a warning on the
//     order (lib/pricing/parseBoundary.ts splitLines);
//   - where the parser documents it, every accepted line satisfies
//     qty > 0 and qty x unit price == line total (to the cent);
//   - a 50k-character line, and a block of 50 lines each MAX_LINE_LENGTH long,
//     parse in well under a second. The per-line cut does not bound a regex
//     whose character class crosses "\n", so the block is the check for that.
//
// Two parsers get a describe of their own below. Simblist reads CSV cells by
// name, so its property is model-based: the parser must import exactly the rows
// whose cells all read and name every other row in a warning. The nuORDER
// printout reads positioned text items rather than lines, so its generator
// mutates items and its property is the documented refuse-to-guess rule.
//
// A property that finds a bug the change in hand cannot fix goes in
// KNOWN_FAILURES with its counterexample and runs as it.skip.

import fc from "fast-check";
import { parseAestheticMovementOrderText } from "@/lib/pricing/aestheticMovementOrderParser";
import { parseBeatrizBallOrderText } from "@/lib/pricing/beatrizBallOrderParser";
import { parseBrandWiseOrderText } from "@/lib/pricing/brandWiseOrderParser";
import { parseFrankEileenText } from "@/lib/pricing/frankEileenParser";
import { parseHDProposalText } from "@/lib/pricing/hdProposalParser";
import { parseKKOrderText, type KKOrderBundle } from "@/lib/pricing/kkOrderParser";
import { parseMarketTimeOrderText } from "@/lib/pricing/marketTimeOrderParser";
import { parseNuOrderText } from "@/lib/pricing/nuorderParser";
import {
  parseNuOrderPrintoutItems,
  type PositionedItem,
} from "@/lib/pricing/nuorderPrintoutParser";
import { MAX_LINE_LENGTH } from "@/lib/pricing/parseBoundary";
import { parseSimblistCsvText } from "@/lib/pricing/simblistCsvOrderParser";
import { parseSuperCatOrderText } from "@/lib/pricing/superCatOrderParser";
import { parseWendoverOrderText } from "@/lib/pricing/wendoverOrderParser";
import { parseZSupplyText } from "@/lib/pricing/zSupplyParser";
import {
  documentFor,
  hostileAmount,
  hostileNumeral,
  moneyLines,
  nastyString,
  numbersIn,
  timeMs,
} from "./support";

/** What every order parser returns: its lines, and the warnings on the order. */
interface Parsed {
  warnings: readonly string[];
  items?: readonly unknown[];
}

interface ParserCase {
  name: string;
  parse: (text: string) => Parsed;
  seed: string[];
  /** Items carry qty/unitPrice/lineTotal and the parser checks qty x price == total. */
  checksLineMath: boolean;
  /** The lines a parse produced, for the seed check. Default: `result.items`. */
  itemsOf?: (result: Parsed) => readonly unknown[];
  /** Why the 300-digit property does not apply, when it does not. */
  noOverlongWarning?: string;
}

const CASES: ParserCase[] = [
  {
    name: "Aesthetic Movement",
    parse: parseAestheticMovementOrderText,
    checksLineMath: true,
    seed: [
      "Vendor: Printworks",
      "PO: #PON00003",
      "Earliest Ship Date October 01, 2026",
      "PW00689",
      "Classic - Tic Tac Toe NEW",
      "7350108174152",
      "12$25.00$300.00",
      "PW00821",
      "Reverra - Mahjong",
      "OOS - ETA EARLY SEPTEMBER",
      "6$90.00$540.00",
      "Order Total: $840.00",
      "Number of Items: 2",
      "Total Quantity: 18",
    ],
  },
  {
    name: "SuperCat",
    parse: parseSuperCatOrderText,
    checksLineMath: true,
    seed: [
      "Ref #:990001-010126-001-1",
      "Item #QtyPriceExt. PriceDescription",
      "9BOATLINEG6$210.00$1,260.00January New - Boa Table Lamp",
      "20BRAD-BSSA4$450.00$1,800.00Bradbury Bar Stool",
      "Merchandise Subtotal$3,060.00",
      "Grand Total$3,060.00",
    ],
  },
  {
    name: "MarketTime",
    parse: parseMarketTimeOrderText,
    checksLineMath: true,
    seed: [
      "Purchase Order by  - ID# 31600001MarketTime",
      " 01/05/2026Order Date:",
      "PON00004",
      "PO #",
      "Graf & Lantz Inc",
      "QtyImageItem #NameUPCPriceUQUOMTotal",
      "1GL60BIN50FTLG",
      "Merino Wool Large Bin - Feather ",
      "84002724476255.00$55.00",
      "6GL70TECH10GN16IN",
      "Sleeve - Granite V (Avail:07/10/26)",
      "84002724051135.00$210.00",
      "$265.00",
      "Sub Total:",
    ],
  },
  {
    name: "BrandWise",
    parse: parseBrandWiseOrderText,
    checksLineMath: true,
    seed: [
      "Sales Order No.B31600001",
      "Panorama City, CAFedEx GroundDana Whitfield8/24/20266/10/2027PON00005",
      "IMAGESKUDESCRIPTIONQTY ORDUNITS",
      'IN-8222The Cadier Wooden Wall Mirrors  23.75" x',
      '35.5"',
      "4EA250.001000.00",
      'IN-8432Chevron Wood Box- 13"x 6.5"x 3.25"4EA70.00280.00',
      "TOTAL IN US$:",
      "1,280.00",
    ],
  },
  {
    name: "Wendover",
    parse: parseWendoverOrderText,
    checksLineMath: false,
    seed: [
      "Your Order #1000000001",
      "Placed on Jan 5, 2026, 10:00:00 AM",
      "ItemsQtyPrice",
      "Before the Rain  Customized",
      "SKU: WLD3511",
      "Medium",
      "Canvas",
      "3$1,200.00",
      "Patterned Dignity 4 3$900.00",
      "SKU: WAN2555",
      "Subtotal$2,100.00",
    ],
  },
  {
    name: "K&K",
    parse: parseKKOrderText,
    checksLineMath: false,
    itemsOf: (result) => (result as KKOrderBundle).orders.flatMap((o) => o.items),
    seed: [
      "Date:   Jan 5, 2026",
      "Order Number: 0001111111",
      "PON5001",
      "PB#INFO [BUNDORD], [],[0001111111],[0.00],[Test Co],[],[t@example.com]",
      "79.99EA",
      "BBB222",
      "1/1/27 2",
      "0.00",
      "2.00",
      "Set of 3 Stackable Widgets",
      "UPC: 222222222222",
      "PB#INFO [BUNDORD], [],[0001111111],[159.98],[Test Co],[],[t@example.com]",
    ],
  },
  {
    name: "Beatriz Ball",
    parse: (t) => parseBeatrizBallOrderText(t),
    checksLineMath: false,
    seed: [
      "Sales Order",
      "PO # PON00002",
      "Order Number:",
      "Order Date:",
      "0090001",
      "6/10/2026",
      "Item Code",
      "Ordered",
      "349672.0045.0018.004GLASS Vento Medium Vase (Clear)",
      "66440.000.000.001Beatriz Ball metal placard",
      "Net Order:90.00",
    ],
  },
  {
    name: "Frank & Eileen",
    parse: parseFrankEileenText,
    checksLineMath: false,
    seed: [
      "FRANK & EILEEN",
      "221044704/13/26",
      "RIVERBSpring 202610/07/2506/01/2606/15/26UPS GROUND",
      "EILEEN",
      "PRBG",
      "Relaxed Button-Up Shirt Pink Red Blue Flowers",
      "  XXS   XS    S    M    L   XL",
      "0010_",
      "    1    1    1    1 128.00     4   512.00",
    ],
  },
  {
    name: "Simblist CSV",
    parse: parseSimblistCsvText,
    checksLineMath: true,
    noOverlongWarning:
      "it reads CSV cells by name and never splits lines; the model-based describe below " +
      "checks that every cell it cannot read is reported",
    seed: [
      "RepGroup,Manufacturer,PO #,Order Date,Order Total",
      "Simblist Group,MAISON ZOE FORD,PON00001,2026-01-05,132.00",
      "Sequence #,Item Number,Name,Quantity,Unit Price,UPC,Total Price",
      "6,ZFUSA07-C,Speedy Cinnamon Roll Mix,2,36.00,10628678860176,$72.00",
      "1,ZFUSA13-C,Brownie Hot Chocolate,1,60.00,10628678860213,$60.00",
    ],
  },
  {
    // The order-confirmation layout (nuorderParser.ts), one field per line.
    name: "nuORDER",
    parse: parseNuOrderText,
    checksLineMath: false,
    seed: [
      "Order #: 7000001",
      "Order Date: JAN 05, 2026",
      "PO #: PON00006",
      "Delivery: 03/01/2026 - 03/15/2026",
      "Terms: Net 30",
      "Pat Doe",
      "pat@example.com",
      "THE EASY TEE",
      "Style #: ET100BLK",
      "MSRP: $98.00",
      "Season: spring 2026",
      "Color: black",
      "Color Code: BLK",
      "$38.50 3 $115.50",
      "Sizes: S: 1 M: 1 L: 1",
      "WIDE LEG PANT",
      "Style #: WL200NVY",
      "MSRP: $148.00",
      "Season: spring 2026",
      "Color: navy",
      "Color Code: NVY",
      "$58.00 2 $116.00",
      "Sizes:",
      "25: 1 26: 1",
      "Total Units: 5",
      "Total Price: $231.50",
      "Sample Brand * Los Angeles CA 90014",
    ],
  },
  {
    // An invoice: style + colour + name run together, the size grid header,
    // then pack count, pack price and extension.
    name: "Z Supply",
    parse: parseZSupplyText,
    checksLineMath: false,
    seed: [
      "INVOICE",
      "7654321",
      "01/05/26",
      "02/04/26",
      "2345678200002-260105Net 30UPS Ground",
      "ZT100001BLKEasy Rib Tank Black",
      "A    B    C    D    E    F   XS    S    M    L   XL    G    H    I    J    K    P    N",
      "1  48.00     48.00",
      ".",
      "1",
      "ZD200002NVYDaily Pant Navy",
      "A    B    C    D    E    F   XS    S    M    L   XL    G    H    I    J    K    P    N",
      "2  60.00     120.00",
      ".",
      "2",
      "18   168.00",
      "168.00",
    ],
  },
  {
    // A Direct Connect client proposal: date + quote number run together, qty +
    // MSRP + each + extended run together, and the MSRP / discount / client
    // price totals line.
    name: "Hunter Douglas",
    parse: parseHDProposalText,
    checksLineMath: false,
    seed: [
      "This proposal is valid through: 02/01/2027",
      "01/02/202770000001",
      "Salesperson",
      "Pat Doe",
      "Sold To:",
      "Dana Reed",
      "12 Elm St",
      "Springfield, IL 62701",
      "Sidemark: Reed Living",
      "1Living",
      "Hunter Douglas Duette Honeycomb Shades",
      "Width 36 Height 48",
      "1250.00200.00200.00",
      "Freight Charges : 15.00",
      "Installation Charges : 40.00",
      "2 Hunter Douglas Silhouette Window Shadings",
      "Width 24 Height 60",
      "2300.00240.00480.00",
      "Freight Charges : 20.00",
      "Installation Charges : 80.00",
      "850.00-170.00680.00",
    ],
  },
];

type Property = "finite" | "overlong" | "slow";

// Properties that currently FAIL, each with the counterexample that shows it, run
// as it.skip. Empty: every parser here reads its numbers and lines through the
// shared parse boundary (lib/pricing/parseBoundary.ts).
const KNOWN_FAILURES: Record<string, Partial<Record<Property, string>>> = {};

describe.each(CASES)(
  "$name order parser (lib/pricing)",
  ({ name, parse, seed, checksLineMath, itemsOf, noOverlongWarning }) => {
    const known = (property: Property) => (KNOWN_FAILURES[name]?.[property] ? it.skip : it);

    it("reaches its number reads: the unmutated seed yields at least one item", () => {
      const result = parse(seed.join("\n"));
      expect((itemsOf ? itemsOf(result) : (result.items ?? [])).length).toBeGreaterThan(0);
    });

    it("never throws on a mutated document", () => {
      fc.assert(
        fc.property(documentFor(seed), (text) => {
          parse(text);
        }),
      );
    });

    known("finite")("puts only finite numbers in its result", () => {
      fc.assert(
        fc.property(documentFor(seed), (text) => {
          for (const [path, n] of numbersIn(parse(text))) {
            expect([path, Number.isFinite(n)]).toEqual([path, true]);
          }
        }),
      );
    });

    if (noOverlongWarning === undefined) {
      known("overlong")("puts a warning on the order when a line holds a 300-digit number", () => {
        fc.assert(
          fc.property(documentFor(seed), (text) => {
            fc.pre(/\d{300}/.test(text));
            // `?? []`: a result with no warnings field at all fails here, not passes.
            expect(parse(text).warnings ?? []).not.toEqual([]);
          }),
        );
      });
    }

    if (checksLineMath) {
      it("accepts a line only when qty > 0 and qty x unit price equals the line total", () => {
        fc.assert(
          fc.property(documentFor(seed), (text) => {
            for (const line of moneyLines(parse(text))) {
              // A non-finite amount is the "finite" property's finding, not this one's.
              if (![line.qty, line.unitPrice, line.lineTotal].every(Number.isFinite)) continue;
              expect(line.qty).toBeGreaterThan(0);
              expect(Math.abs(line.qty * line.unitPrice - line.lineTotal)).toBeLessThanOrEqual(
                0.0100001,
              );
            }
          }),
        );
      });
    }

    known("slow")(
      "parses a 50k-character line, and 50 lines of MAX_LINE_LENGTH, in well under a second",
      () => {
        // A label the parser looks for (its own seed lines, plus common ones),
        // then one character repeated -- the shape that makes a backtracking
        // regex go quadratic -- then a tail that forces the match to fail late.
        const anchor = fc.oneof(
          fc.constantFrom(...seed),
          fc.constantFrom(
            "",
            "Vendor: a",
            "PO: #",
            "Earliest Ship Date a",
            "SKU: ",
            "Order Number: ",
            "Date: ",
            "1$",
          ),
        );
        const filler = fc.constantFrom(" ", "9", " ", "9", "$", ",", "a", "\t", ".0");
        const tail = fc.constantFrom("", "b", "$1.00");
        // Where the hostile text goes: first, half the time, so a regex over the
        // whole text meets it before the seed's own match ends the scan (placed
        // after the seed, it never reached nuORDER's footer regex, which matched
        // the seed's footer first); else a random line, which can fall inside an
        // item's block.
        const position = fc.oneof(fc.constant(0), fc.nat());
        fc.assert(
          fc.property(anchor, filler, tail, position, (pre, unit, post, at) => {
            const run = unit.repeat(Math.ceil(50_000 / unit.length));
            const line = pre + run + post;
            // Every line already at the cut: a regex that crosses "\n" still sees 50k.
            const atCut = (pre + run).slice(0, MAX_LINE_LENGTH - post.length) + post;
            const block = Array.from({ length: 50 }, () => atCut);
            const i = at % (seed.length + 1);
            for (const hostile of [[line], block]) {
              const doc = [...seed.slice(0, i), ...hostile, ...seed.slice(i)];
              expect(timeMs(() => parse(doc.join("\n")))).toBeLessThan(500);
            }
          }),
        );
      },
    );
  },
);

// ── Simblist CSV: a model-based property ─────────────────────────────────────
//
// The CSV is built from a model: an Order Total, then 1-5 item rows. Each row's
// Quantity, Unit Price and Total Price cell is either valid or hostile, and the
// model knows which. A valid row has qty 1-99, a price from whole cents with an
// optional "$", and a total of qty x price computed in cents, so it always
// passes the parser's own line check.
//
// A BLANK price cell keeps importing at $0 with no warning (owner decision,
// 2026-11-21), so it is neither valid nor hostile and the model never makes
// one. A blank Quantity has always left its line out with a warning, so it is
// hostile.

const unreadable = fc.constantFrom(
  "9".repeat(400),
  `$${"9".repeat(400)}.00`,
  "Infinity",
  "-Infinity",
  "1e999",
  "NaN",
  "abc",
);
const unreadableQty = fc.oneof(unreadable, fc.constantFrom("", "1.5"));

/** A cell that is valid (null: keep the model's value) three times in four. */
const maybe = (hostile: fc.Arbitrary<string>) =>
  fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: hostile });

interface SimblistRow {
  itemNumber: string;
  qty: string;
  price: string;
  total: string;
  valid: boolean;
}

const simblistRow = fc
  .record({
    qty: fc.integer({ min: 1, max: 99 }),
    priceCents: fc.nat(9_999_999),
    dollarPrice: fc.boolean(),
    dollarTotal: fc.boolean(),
    badQty: maybe(unreadableQty),
    badPrice: maybe(unreadable),
    badTotal: maybe(unreadable),
  })
  .map((r): Omit<SimblistRow, "itemNumber"> => ({
    qty: r.badQty ?? String(r.qty),
    price: r.badPrice ?? `${r.dollarPrice ? "$" : ""}${(r.priceCents / 100).toFixed(2)}`,
    total: r.badTotal ?? `${r.dollarTotal ? "$" : ""}${((r.priceCents * r.qty) / 100).toFixed(2)}`,
    valid: r.badQty === null && r.badPrice === null && r.badTotal === null,
  }));

const simblistOrder = fc
  .record({
    orderTotal: fc.oneof(
      fc.constant({ text: "", unreadable: false }),
      fc.nat(99_999_999).map((c) => ({ text: (c / 100).toFixed(2), unreadable: false })),
      unreadable.map((text) => ({ text, unreadable: true })),
    ),
    rows: fc.array(simblistRow, { minLength: 1, maxLength: 5 }),
  })
  .map(({ orderTotal, rows }) => {
    const items: SimblistRow[] = rows.map((r, i) => ({ ...r, itemNumber: `A${i + 1}` }));
    const text = [
      "RepGroup,Manufacturer,PO #,Order Date,Order Total",
      `Simblist Group,SAMPLE MAKER,PON00001,2026-01-05,${orderTotal.text}`,
      "Sequence #,Item Number,Name,Quantity,Unit Price,UPC,Total Price",
      ...items.map(
        (r, i) =>
          `${i + 1},${r.itemNumber},Item ${i + 1},${r.qty},${r.price},0001234567890,${r.total}`,
      ),
    ].join("\n");
    return { text, orderTotal, items };
  });

describe("Simblist CSV order parser: every cell it cannot read (model-based)", () => {
  it("imports exactly the rows whose Quantity, Unit Price and Total Price all read", () => {
    fc.assert(
      fc.property(simblistOrder, ({ text, items }) => {
        expect(parseSimblistCsvText(text).items.map((i) => i.itemNumber)).toEqual(
          items.filter((r) => r.valid).map((r) => r.itemNumber),
        );
      }),
    );
  });

  it("names every row it leaves out in a warning", () => {
    fc.assert(
      fc.property(simblistOrder, ({ text, items }) => {
        const { warnings } = parseSimblistCsvText(text);
        for (const row of items.filter((r) => !r.valid)) {
          expect([
            row.itemNumber,
            warnings.some((w) => w.startsWith(`Item ${row.itemNumber}:`)),
          ]).toEqual([row.itemNumber, true]);
        }
      }),
    );
  });

  it("warns when a non-blank Order Total does not read", () => {
    fc.assert(
      fc.property(simblistOrder, ({ text, orderTotal }) => {
        fc.pre(orderTotal.unreadable);
        expect(parseSimblistCsvText(text).warnings.some((w) => w.includes("Order Total"))).toBe(
          true,
        );
      }),
    );
  });

  it("puts only finite numbers in its result", () => {
    fc.assert(
      fc.property(simblistOrder, ({ text }) => {
        for (const [path, n] of numbersIn(parseSimblistCsvText(text))) {
          expect([path, Number.isFinite(n)]).toEqual([path, true]);
        }
      }),
    );
  });
});

// ── nuORDER order printout: positioned text items ────────────────────────────
//
// The printout parser (nuorderPrintoutParser.ts) works from pdfjs text items
// with x/y positions, not lines. The seed is the geometry of its unit tests
// (nuorderPrintoutParser.test.ts), values invented: a letter-size grid block
// and a one-size block. Ops delete or duplicate an item, swap one item's digit
// runs for hostile numerals, turn every money amount on the page into one
// hostile amount (price AND totals, as the line op does), or insert a nasty
// token at a size column's x on an existing row.

const pi = (str: string, x: number, y: number): PositionedItem => ({ str, x, y });

const styleAnchor = (style: string, wholesale: string, retail: string, y: number) => [
  pi("Style #", 57, y),
  pi(style, 80, y),
  pi("|", 104, y),
  pi("JUNE '26", 108, y),
  pi("Wholesale:", 373, y),
  pi(`USD ${wholesale}`, 409, y),
  pi("Sugg. Retail:", 458, y),
  pi(`USD ${retail}`, 501, y),
];

const PRINTOUT_SEED: PositionedItem[] = [
  pi("PO#:", 476, 791),
  pi("19900003", 500, 791),
  pi("Created:", 55, 764),
  pi("01/05/2026", 84, 764),
  pi("Start Ship:", 55, 757),
  pi("03/01/2026", 90, 757),
  pi("Complete Ship:", 55, 750),
  pi("03/15/2026", 105, 750),
  pi("Terms:", 55, 743),
  pi("NET 30", 79, 743),
  // A letter-size grid: four units under XS-L, Qty 4, line total 4 x 128.00.
  pi("Sample Button-Up Shirt", 57, 687),
  ...styleAnchor("SAMPLE1", "128.00", "274.00", 675),
  pi("Colors", 147, 658),
  pi("Total", 502, 658),
  pi("XXS", 310, 654),
  pi("XS", 331, 654),
  pi("S", 351, 654),
  pi("M", 368, 654),
  pi("L", 387, 654),
  pi("XL", 403, 654),
  pi("Qty", 421, 654),
  pi("PRBG", 183, 639),
  pi("Pink Red Blue", 202, 639),
  pi("1", 333, 636),
  pi("1", 351, 636),
  pi("1", 369, 636),
  pi("1", 387, 636),
  pi("4", 425, 636),
  pi("USD 512.00", 480, 636),
  // A one-size block: two units, line total 2 x 48.00.
  pi("Sample Canvas Tote", 57, 610),
  ...styleAnchor("SAMPLE2", "48.00", "110.00", 600),
  pi("Colors", 147, 585),
  pi("Total", 473, 585),
  pi("OS", 352, 581),
  pi("Qty", 372, 581),
  pi("Natural", 183, 570),
  pi("2", 355, 570),
  pi("2", 376, 570),
  pi("USD 96.00", 451, 570),
  pi("Total Quantity:", 346, 533),
  pi("6", 519, 533),
  pi("Subtotal:", 346, 523),
  pi("USD 608.00", 461, 523),
  pi("Grand Total:", 346, 513),
  pi("USD 608.00", 461, 513),
];

/** The x of every size and total column in the seed, where a stray token lands. */
const GRID_XS = [310, 331, 351, 352, 368, 372, 387, 403, 421, 425, 451, 480];

type PrintoutOp =
  | { kind: "delete"; at: number }
  | { kind: "duplicate"; at: number }
  | { kind: "numerals"; at: number; nums: string[] }
  | { kind: "amounts"; amount: string }
  | { kind: "insert"; at: number; x: number; text: string };

const printoutOp: fc.Arbitrary<PrintoutOp> = fc.oneof(
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("duplicate" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("numerals" as const),
    at: fc.nat(),
    nums: fc.array(hostileNumeral, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ kind: fc.constant("amounts" as const), amount: hostileAmount }),
  fc.record({
    kind: fc.constant("insert" as const),
    at: fc.nat(),
    x: fc.constantFrom(...GRID_XS),
    text: fc.oneof(
      nastyString(2),
      hostileNumeral,
      hostileAmount.map((a) => `USD ${a}`),
    ),
  }),
);

function mutatePrintout(ops: readonly PrintoutOp[]): PositionedItem[] {
  const items = [...PRINTOUT_SEED];
  for (const o of ops) {
    if (o.kind === "amounts") {
      for (let i = 0; i < items.length; i++) {
        items[i] = { ...items[i], str: items[i].str.replace(/\d[\d,]*\.\d+/g, o.amount) };
      }
      continue;
    }
    if (items.length === 0) continue;
    const i = o.at % items.length;
    if (o.kind === "delete") items.splice(i, 1);
    else if (o.kind === "duplicate") items.splice(i, 0, items[i]);
    else if (o.kind === "insert") items.splice(i, 0, pi(o.text, o.x, items[i].y));
    else {
      let n = 0;
      const str = items[i].str.replace(/\d+/g, (m) => (n < o.nums.length ? o.nums[n++] : m));
      items[i] = { ...items[i], str };
    }
  }
  return items;
}

const printoutPage = fc.array(printoutOp, { maxLength: 6 }).map(mutatePrintout);

describe("nuORDER order printout parser (lib/pricing, positioned items)", () => {
  it("reaches its number reads: the unmutated seed yields at least one item", () => {
    const parsed = parseNuOrderPrintoutItems([PRINTOUT_SEED]);
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.warnings).toEqual([]);
  });

  it("never throws on a mutated page", () => {
    fc.assert(
      fc.property(printoutPage, (page) => {
        parseNuOrderPrintoutItems([page]);
      }),
    );
  });

  it("puts only finite numbers in its result", () => {
    fc.assert(
      fc.property(printoutPage, (page) => {
        for (const [path, n] of numbersIn(parseNuOrderPrintoutItems([page]))) {
          expect([path, Number.isFinite(n)]).toEqual([path, true]);
        }
      }),
    );
  });

  it("keeps an item only when its sizes sum to its units and units x price is its total", () => {
    fc.assert(
      fc.property(printoutPage, (page) => {
        for (const item of parseNuOrderPrintoutItems([page]).items) {
          expect(item.sizes.reduce((sum, s) => sum + s.quantity, 0)).toBe(item.totalUnits);
          expect(Math.abs(item.unitPrice * item.totalUnits - item.totalPrice)).toBeLessThanOrEqual(
            0.0100001,
          );
        }
      }),
    );
  });

  it("parses a page holding a 50k-character token in well under a second", () => {
    // Beside a line total (a grid token), before the Grand Total's amount, and
    // in the style row's price.
    const where = fc.constantFrom({ x: 480, y: 636 }, { x: 400, y: 513 }, { x: 409, y: 675 });
    const filler = fc.constantFrom("9", ",", "9,", ".0", " ", "a");
    fc.assert(
      fc.property(
        where,
        fc.constantFrom("", "USD ", "USD 1"),
        filler,
        fc.constantFrom("", ".00", "b"),
        (at, pre, unit, post) => {
          const token = pre + unit.repeat(Math.ceil(50_000 / unit.length)) + post;
          const page = [...PRINTOUT_SEED, pi(token, at.x, at.y)];
          expect(timeMs(() => parseNuOrderPrintoutItems([page]))).toBeLessThan(500);
        },
      ),
    );
  });
});
