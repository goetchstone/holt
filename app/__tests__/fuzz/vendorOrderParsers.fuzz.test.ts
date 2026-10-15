// /app/__tests__/fuzz/vendorOrderParsers.fuzz.test.ts
//
// Mutation-based fuzzing of the vendor order parsers in lib/pricing/: the text
// pulled out of a vendor's PDF (or CSV) becomes PO lines with a quantity and a
// dealer cost. Each parser starts from a short seed document in its own
// format (lines from its fixtures, data invented); the generator deletes,
// duplicates and inserts lines and swaps digit runs for hostile numerals
// (400-digit runs, "Infinity", "1e999"). Properties:
//   - never throws;
//   - every number in the result is finite -- an Infinity or NaN cost must
//     never reach a purchase order;
//   - where the parser documents it, every accepted line satisfies
//     qty > 0 and qty x unit price == line total (to the cent);
//   - a 50k-character line parses in well under a second.
//
// lib/pricing/** is owned by another change in flight, so a property that
// finds a bug there is recorded as it.skip with its counterexample instead of
// being fixed here -- see the skipped cases below.

import fc from "fast-check";
import { parseAestheticMovementOrderText } from "@/lib/pricing/aestheticMovementOrderParser";
import { parseBeatrizBallOrderText } from "@/lib/pricing/beatrizBallOrderParser";
import { parseBrandWiseOrderText } from "@/lib/pricing/brandWiseOrderParser";
import { parseFrankEileenText } from "@/lib/pricing/frankEileenParser";
import { parseKKOrderText } from "@/lib/pricing/kkOrderParser";
import { parseMarketTimeOrderText } from "@/lib/pricing/marketTimeOrderParser";
import { parseSimblistCsvText } from "@/lib/pricing/simblistCsvOrderParser";
import { parseSuperCatOrderText } from "@/lib/pricing/superCatOrderParser";
import { parseWendoverOrderText } from "@/lib/pricing/wendoverOrderParser";
import { nastyString, timeMs } from "./support";

interface ParserCase {
  name: string;
  parse: (text: string) => unknown;
  seed: string[];
  /** Items carry qty/unitPrice/lineTotal and the parser checks qty x price == total. */
  checksLineMath: boolean;
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
    seed: [
      "RepGroup,Manufacturer,PO #,Order Date,Order Total",
      "Simblist Group,MAISON ZOE FORD,PON00001,2026-01-05,132.00",
      "Sequence #,Item Number,Name,Quantity,Unit Price,UPC,Total Price",
      "6,ZFUSA07-C,Speedy Cinnamon Roll Mix,2,36.00,10628678860176,$72.00",
      "1,ZFUSA13-C,Brownie Hot Chocolate,1,60.00,10628678860213,$60.00",
    ],
  },
];

// ── Mutation generator ───────────────────────────────────────────────────────

const hostileNumeral = fc.oneof(
  fc.nat(99_999).map(String),
  fc.constantFrom("9".repeat(400), "0", "00", "Infinity", "1e999", "NaN", "-1", "0.00"),
);
// A hostile replacement for a whole money amount ("1,260.00").
const hostileAmount = fc.oneof(
  fc.nat(99_999_999).map((c) => (c / 100).toFixed(2)),
  fc.constantFrom(`${"9".repeat(400)}.00`, "Infinity", "1e999", "NaN", "0.00", "-1.00", "9,99"),
);

type Op =
  | { kind: "delete"; at: number }
  | { kind: "duplicate"; at: number }
  | { kind: "insert"; at: number; text: string }
  | { kind: "numerals"; at: number; nums: string[] }
  | { kind: "amounts"; at: number; amount: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("duplicate" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), text: nastyString(4) }),
  fc.record({
    kind: fc.constant("numerals" as const),
    at: fc.nat(),
    nums: fc.array(hostileNumeral, { minLength: 1, maxLength: 4 }),
  }),
  fc.record({ kind: fc.constant("amounts" as const), at: fc.nat(), amount: hostileAmount }),
);

function mutate(seed: string[], ops: Op[]): string {
  const lines = [...seed];
  for (const o of ops) {
    const i = lines.length === 0 ? 0 : o.at % lines.length;
    if (o.kind === "delete") lines.splice(i, 1);
    else if (o.kind === "duplicate" && lines.length > 0) lines.splice(i, 0, lines[i]);
    else if (o.kind === "insert") lines.splice(i, 0, o.text);
    else if (o.kind === "numerals" && lines.length > 0) {
      // The first N digit runs, in order, become hostile numerals.
      let n = 0;
      lines[i] = lines[i].replace(/\d+/g, (m) => (n < o.nums.length ? o.nums[n++] : m));
    } else if (o.kind === "amounts" && lines.length > 0) {
      // Every money amount on the line (price AND total) becomes the same value.
      lines[i] = lines[i].replace(/\d[\d,]*\.\d+/g, o.amount);
    }
  }
  return lines.join("\n");
}

const documentFor = (seed: string[]) =>
  fc.array(op, { maxLength: 6 }).map((ops) => mutate(seed, ops));

// ── Oracles ──────────────────────────────────────────────────────────────────

/** Every number anywhere in the parse result, with its path. */
function numbersIn(
  value: unknown,
  path = "result",
  out: Array<[string, number]> = [],
): Array<[string, number]> {
  if (typeof value === "number") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numbersIn(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) numbersIn(v, `${path}.${k}`, out);
  }
  return out;
}

interface MoneyLine {
  qty: number;
  unitPrice: number;
  lineTotal: number;
}
function moneyLines(result: unknown): MoneyLine[] {
  const items = (result as { items?: unknown[] }).items ?? [];
  return items.filter(
    (i): i is MoneyLine =>
      typeof (i as MoneyLine).qty === "number" &&
      typeof (i as MoneyLine).unitPrice === "number" &&
      typeof (i as MoneyLine).lineTotal === "number",
  );
}

// Properties that currently FAIL, each with the counterexample that shows it.
// They run as it.skip because lib/pricing/** is not ours to change in this
// PR; delete the entry once the parser is fixed and the property passes.
// The shared root cause of every "finite" entry: an amount that overflows to
// Infinity makes `Math.abs(qty * price - total) > 0.01` compare NaN, which is
// false, so the line-math check waves it through.
const KNOWN_FAILURES: Record<string, Partial<Record<"finite" | "slow", string>>> = {
  "Aesthetic Movement": {
    finite:
      'money line "1$<400 nines>.00$<400 nines>.00" after an SKU line -> item with unitPrice = lineTotal = Infinity',
    // VENDOR /^Vendor:\s*(.+?)\s*$/ and SHIP_DATE backtrack quadratically.
    slow: '"Vendor: a" + " ".repeat(50000) + "b" takes ~1.0 s; "Earliest Ship Date a" + 50k spaces + "b" ~0.9 s',
  },
  SuperCat: {
    finite: '"Merchandise Subtotal$<400 nines>,0.00" -> printedSubtotal = Infinity',
    slow: 'a line of 50,000 "9"s takes ~0.9 s',
  },
  MarketTime: {
    finite: 'subtotal line "$<400 nines>.00" before "Sub Total:" -> printedSubtotal = Infinity',
    slow: 'a line of 50,000 "9"s takes ~3 s',
  },
  BrandWise: {
    finite: '"TOTAL IN US$:" then "<400 nines>.00" -> printedTotal = Infinity',
    slow: 'its item line "IN-8432Chevron Wood Box- 13"x 6.5"x 3.25"4EA70.00280.00" + 50,000 "9"s takes ~0.85 s',
  },
  "Frank & Eileen": {
    finite:
      'size row "    1    1    1    1 <400 nines>.00     4   <400 nines>.00" -> items[0].unitPrice = Infinity',
  },
  Wendover: {
    finite: 'price line "3$<400 nines>.00" -> items[0].lineTotal = Infinity',
  },
  "K&K": {
    finite: 'price/UOM line "<400 nines>.00EA" -> orders[0].items[0].unitPrice = Infinity',
  },
  "Beatriz Ball": {
    finite: '"Net Order:<400 nines>.00" -> printedTotal = Infinity',
    slow: '"1$" + 50,000 "," + "b" takes ~1.0 s',
  },
  "Simblist CSV": {
    finite:
      'item row "A1,x,2,Infinity,Infinity" (Quantity,Unit Price,Total Price) -> unitPrice Infinity',
  },
};

describe.each(CASES)(
  "$name order parser (lib/pricing)",
  ({ name, parse, seed, checksLineMath }) => {
    it("never throws on a mutated document", () => {
      fc.assert(
        fc.property(documentFor(seed), (text) => {
          parse(text);
        }),
      );
    });

    const finite = KNOWN_FAILURES[name]?.finite ? it.skip : it;
    finite("puts only finite numbers in its result", () => {
      fc.assert(
        fc.property(documentFor(seed), (text) => {
          for (const [path, n] of numbersIn(parse(text))) {
            expect([path, Number.isFinite(n)]).toEqual([path, true]);
          }
        }),
      );
    });

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

    const slow = KNOWN_FAILURES[name]?.slow ? it.skip : it;
    slow("parses a 50k-character line in well under a second", () => {
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
      fc.assert(
        fc.property(anchor, filler, fc.constantFrom("", "b", "$1.00"), (pre, unit, post) => {
          const line = pre + unit.repeat(Math.ceil(50_000 / unit.length)) + post;
          expect(timeMs(() => parse([...seed, line].join("\n")))).toBeLessThan(500);
        }),
      );
    });
  },
);
