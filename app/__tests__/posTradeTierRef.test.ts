// /app/__tests__/posTradeTierRef.test.ts
//
// GAP-06 part C: a register line added after an await is priced for the
// customer picked while the await was out.
//
// handleScan and addProductFromSearch fetch a product's stock and only then
// call addProductToCart. Had addProductToCart closed over the render's
// `tradeTier`, a trade customer picked during that fetch would re-price the
// lines already in the cart (chooseCustomer) and then have the new line
// appended at retail by the callback from before the pick: the trade customer
// charged retail, and nothing on the screen saying so. So the new line is
// priced inside the cart updater from `tradeTierRef`, which chooseCustomer
// sets on every pick, and chooseCustomer is the only way the customer changes.
//
// A source-text tripwire (rule 12): the race lives in React's closures, and
// this repo's unit project runs in node with no DOM renderer to drive the
// component. What it guards is "someone put the closure back".

import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.join(__dirname, "../src/app/(dashboard)/app/sales/pos/PosView.tsx"),
  "utf8",
);

/** The text of `const <name> = useCallback(` up to its dependency list. */
function callbackBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  );", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 5);
}

describe("the register prices a new line for the latest customer pick", () => {
  it("addProductToCart prices from tradeTierRef inside the cart updater, not from its render's tier", () => {
    const body = callbackBody("addProductToCart");
    const updater = body.slice(body.indexOf("setCart((prev) =>"));
    expect(updater).toContain("priceLineForTier(");
    expect(updater).toContain("tradeTierRef.current");
    // No bare `tradeTier` (the render's value) anywhere in the callback or its deps.
    expect(body).not.toMatch(/\btradeTier\b(?!Ref)/);
  });

  it("chooseCustomer keeps the ref in step, and is the only way the customer changes", () => {
    const choose = source.slice(source.indexOf("const chooseCustomer = ("));
    const chooseBody = choose.slice(0, choose.indexOf("\n  };"));
    expect(chooseBody).toMatch(/tradeTierRef\.current = /);
    expect(chooseBody).toContain("setSelectedCustomer(customer)");
    // Any other setter would change the customer without the ref.
    expect(source.match(/setSelectedCustomer\(/g)).toHaveLength(1);
  });
});
