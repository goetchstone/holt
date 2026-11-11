// /app/__tests__/countedLineOwedSites.test.ts
//
// A gift card sold on a sale is a line (OrderLineItem.giftCardNumber is set). The
// customer owes it, but it is a liability the store holds, not sales revenue, and it
// isn't goods. So the counted-line filter (rule 33) comes in two kinds
// (lib/salesOrderRevenue.ts):
//
//   * the OWED kind keeps a card line in: COUNTED_LINE_FILTER, isCountedLine,
//     countedLineSql / countedLineSqlText, and COUNTED_LINE_STATUSES spelled by hand;
//   * the ITEM kind leaves it out: COUNTED_ITEM_LINE, isCountedItemLine,
//     countedItemLineSql / countedItemLineSqlText, and buildLineItemWhere.
//
// Both read as "cancelled lines out", so a new revenue total that reaches for the
// familiar one compiles, reads correctly, and counts every card sold as sales. Nothing
// would notice: the number is merely high by a believable margin (principle 2).
//
// This is a manifest and a tripwire (rule 65). Every file that uses the OWED kind is
// listed below with the reason a card line belongs in what it computes, and the check
// fails in BOTH directions:
//   - a file uses the owed kind and isn't listed: decide which kind it needs; if it's a
//     total of what a customer owes, list it here with why, otherwise use the item kind;
//   - a listed file no longer uses it: the manifest is stale; take the entry out.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(__dirname, "..");

/** Where a card line counts as owed, and why. */
const OWED: Record<string, string> = {
  "src/app/(dashboard)/app/sales/orders/[id]/OrderDetailView.tsx":
    "the order screen's own total, tax and balance due, the payment-link deposit amount, and which lines show as live; a card line is on the order and owed",
  "src/lib/customerLedger.ts":
    "the customer's AR balance, lines less payments; a card line is owed until it's paid",
  "src/lib/customerLedgerBackfill.ts":
    "the SALE amount in the AR ledger backfill, which payments offset; the customer owes for a card line",
  "src/lib/delivery/deliveryFee.ts":
    "after a fee change it recomputes the order's own totalTax from every owed line; the pieces for the truck use COUNTED_ITEM_LINE",
  "src/lib/paymentService.ts":
    "computeBalance, the total due at checkout, on a payment link and in the portal; a card line is owed",
  "src/lib/reports/balanceAging.ts":
    "the balance due on open orders, the order total less payments; a card line is owed",
  "src/pages/api/portal/order.ts":
    "the lines the customer portal lists beside the balance due, which must add up to it",
  "src/pages/api/portal/pay.ts":
    "names what the portal checkout pays for: the balance due, a card line in it",
  "src/pages/api/sales/orders/[id].ts":
    "the order's own totalTax and totalAmount on the order detail screen",
  "src/pages/api/sales/orders/index.ts":
    "each order's own totalTax and totalAmount in the order list",
  "src/pages/api/stripe/send-payment-link.ts":
    "names what a payment link pays for: the balance due, a card line in it",
  "src/pages/api/warehouse/awaiting-delivery.ts":
    "the balance due on each order waiting for delivery (computeBalance over these lines)",
  "src/pages/api/dispatch/orders-by-zone.ts":
    "the balance due on each order on the dispatch board; the pieces for the truck are filtered with isCountedItemLine",

  // Quotes only. A card is sold on an order, not quoted, so no card line reaches these;
  // if a quote ever can hold one, these are pipeline value and move to the item kind.
  "src/lib/reports/pipelineOpportunity.ts":
    "the drilldown reads QUOTE orders only; the summary SQL beside it uses countedItemLineSqlText",
  "src/lib/reports/staleQuotes.ts": "the stale quote value, read from QUOTE orders only",
  "src/lib/tax/rerateQuoteTax.ts":
    "re-rates a QUOTE's tax (its one caller checks the status), so only quote lines reach it",
  "src/lib/pipelineClientQuery.ts":
    "COUNTED_QUOTE_LINE, built from COUNTED_LINE_STATUSES, is read on QUOTE orders only; its order reads use COUNTED_ITEM_LINE",

  // Where the two kinds are defined.
  "src/lib/salesOrderRevenue.ts":
    "defines COUNTED_LINE_FILTER and isCountedLine, and builds COUNTED_ITEM_LINE and isCountedItemLine from them",
  "src/lib/reports/revenueScope.ts":
    "defines countedLineSql and countedLineSqlText beside their item forms",
};

/** The owed kind, in each spelling. The item kind's names don't match these. */
const OWED_FORMS = [
  /\bCOUNTED_LINE_FILTER\b/,
  /\bCOUNTED_LINE_STATUSES\b/,
  /\bcountedLineSql(?:Text)?\b/,
  /\bisCountedLine\b/,
];

/** Code only: a filter described in a comment, or imported and never used, is not a use of it. */
function codeOf(source: string): string {
  return source
    .replace(/^import\s[^;]*?\sfrom\s+["'][^"']+["'];?/gm, "")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function usesOwedKind(source: string): boolean {
  const code = codeOf(source);
  return OWED_FORMS.some((form) => form.test(code));
}

describe("which files keep a gift card line in their counted lines (rule 65)", () => {
  const found = sourceFiles(join(APP_DIR, "src"))
    .filter((file) => usesOwedKind(readFileSync(file, "utf8")))
    .map((file) => relative(APP_DIR, file).split("\\").join("/"))
    .sort();

  it("finds no file using the owed filter that isn't listed", () => {
    const unlisted = found.filter((file) => !(file in OWED));
    if (unlisted.length > 0) {
      throw new Error(
        `These files count lines with the filter that keeps a gift card line in:\n  ${unlisted.join("\n  ")}\n` +
          "A card sold on a sale is owed, but it isn't revenue or goods. For a sale, report, " +
          "commission or stock total use COUNTED_ITEM_LINE, isCountedItemLine or " +
          "countedItemLineSql(Text) instead. If it really is what a customer owes, list it in " +
          "__tests__/countedLineOwedSites.test.ts with why.",
      );
    }
  });

  it("keeps no entry whose file stopped using it", () => {
    expect(Object.keys(OWED).filter((file) => !found.includes(file))).toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const [file, reason] of Object.entries(OWED)) {
      expect({ file, hasReason: reason.trim().length > 20 }).toEqual({ file, hasReason: true });
    }
  });

  it("tells the two kinds apart, and ignores comments", () => {
    expect(usesOwedKind("where: { lineItemStatus: COUNTED_LINE_FILTER }")).toBe(true);
    expect(usesOwedKind("lines.filter(isCountedLine)")).toBe(true);
    expect(usesOwedKind("AND countedLineSqlText('li')")).toBe(true);
    expect(usesOwedKind("Prisma.join([...COUNTED_LINE_STATUSES])")).toBe(true);
    expect(usesOwedKind("where: { ...COUNTED_ITEM_LINE }")).toBe(false);
    expect(usesOwedKind("lines.filter(isCountedItemLine)")).toBe(false);
    expect(usesOwedKind("AND countedItemLineSql('li') AND countedItemLineSqlText('x')")).toBe(
      false,
    );
    expect(usesOwedKind("// was lineItemStatus: COUNTED_LINE_FILTER\n * isCountedLine")).toBe(
      false,
    );
    expect(usesOwedKind("total(); // see isCountedLine")).toBe(false);
    expect(
      usesOwedKind('import {\n  COUNTED_LINE_FILTER,\n  X,\n} from "@/lib/salesOrderRevenue";'),
    ).toBe(false);
  });
});
