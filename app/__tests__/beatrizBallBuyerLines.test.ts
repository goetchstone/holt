// /app/__tests__/beatrizBallBuyerLines.test.ts
//
// A vendor confirmation repeats the BUYER's name and address in its header, and
// the parser skips those lines. It used to skip them by hardcoding one
// deployment's name -- "saybrook", "old saybrook" -- which made the parser
// correct for exactly one company.
//
// The failure is quiet, which is what makes it worth a test. A line the parser
// does not recognise as boilerplate and cannot read as an item is treated as a
// WRAPPED DESCRIPTION and appended to the item above it. So an unrecognised
// buyer name does not error -- it silently renames the previous line item.

import { buyerBoilerplate, parseBeatrizBallOrderText } from "@/lib/pricing/beatrizBallOrderParser";

/**
 * An item line followed by the buyer's own name, which is the order these
 * appear in when the header repeats mid-document. Without the skip, the name is
 * appended to the item above.
 */
function confirmation(buyerName: string): string {
  return [
    "Sales Order 12345",
    "349699.0056.0024.754GLASS Vento Medium Vase (Clear)",
    buyerName,
    "123 Harbour Road",
  ].join("\n");
}

function itemNames(text: string, buyerLines: readonly string[]): string {
  return parseBeatrizBallOrderText(text, buyerLines)
    .items.map((i) => i.name)
    .join(" | ")
    .toLowerCase();
}

describe("the buyer's own name never lands in an item", () => {
  it("skips it when the deployment's identity is supplied", () => {
    expect(
      itemNames(confirmation("Northwind Home"), buyerBoilerplate("Northwind Home")),
    ).not.toContain("northwind");
  });

  it("appends it when it is NOT supplied — the bug this guards", () => {
    // Proves the fixture actually exercises the path: with no buyer lines the
    // name really does get glued onto the item above.
    expect(itemNames(confirmation("Northwind Home"), [])).toContain("northwind");
  });

  it("works for any deployment, naming none of them in code", () => {
    for (const name of ["Northwind Home", "Kestrel & Co", "Old Saybrook"]) {
      expect(itemNames(confirmation(name), buyerBoilerplate(name))).not.toContain(
        name.toLowerCase(),
      );
    }
  });

  it("still skips the vendor's own letterhead with no buyer lines given", () => {
    // Vendor boilerplate stays hardcoded on purpose: every Beatriz Ball
    // confirmation carries it, whoever is buying.
    expect(itemNames(confirmation("Northwind Home"), [])).not.toContain("sales order");
  });
});

describe("buyerBoilerplate is forgiving about what it is handed", () => {
  it("lower-cases, trims, and drops blanks and stubs", () => {
    expect(buyerBoilerplate("  Northwind Home  ", null, undefined, "", "ab")).toEqual([
      "northwind home",
    ]);
  });
});
