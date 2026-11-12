// /app/__tests__/giftCardWriters.test.ts
//
// Rule 65: every file that writes a gift card or its history is listed here with the reason, and
// a new one fails until it's added. A card's balance changes only through lib/giftCardLedger.ts
// (owner, 2026-11-11: "everything must be transactional, be on a ledger"); the review of that
// change found the demo seed still writing balances by hand, which a list like this would have
// caught. Both directions: a listed file that no longer writes fails too, so the list can't go
// stale. A source-text tripwire is right here (rule 57): the class is "a writer exists".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(__dirname, "..");
const WRITE =
  /giftCard\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\(|giftCardTransaction\.(create|createMany|update|updateMany|delete|deleteMany)\(|UPDATE "GiftCard"/;

// Selling or reloading a card is a line on a sale; lib/sales/giftCardLines.ts issues it with the
// payment that pays the sale off, through the ledger's issueCard and creditToCard, so it writes no
// card itself and isn't listed.
const ALLOWED: Record<string, string> = {
  "src/lib/giftCardLedger.ts":
    "the one way a balance changes, and the one way a sold card is issued (issueCard)",
  "src/pages/api/gift-cards/import.ts":
    "onboarding import: a new card with its IMPORT row, or a locked re-import of an untouched card",
  "src/pages/api/gift-cards/[id]/index.ts": "edits a card's notes only, never its balance",
  "prisma/seed/demo/salesOrders.ts": "the demo seed: each card's history adds up to its balance",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const writers = [...files(join(APP, "src")), ...files(join(APP, "prisma", "seed"))]
  .filter((path) => WRITE.test(readFileSync(path, "utf8")))
  .map((path) => relative(APP, path))
  .sort();

describe("who writes a gift card", () => {
  it("only the listed files, each with its reason", () => {
    expect(writers.filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it("every listed file still writes one, so the list can't go stale", () => {
    expect(Object.keys(ALLOWED).filter((f) => !writers.includes(f))).toEqual([]);
  });

  it("the card's notes route touches only its notes", () => {
    const src = readFileSync(join(APP, "src/pages/api/gift-cards/[id]/index.ts"), "utf8");
    const update = src.slice(src.indexOf("prisma.giftCard.update("));
    const data = update.slice(update.indexOf("data:"), update.indexOf("},") + 2);
    expect(data).not.toMatch(/currentBalance|status/);
  });
});
