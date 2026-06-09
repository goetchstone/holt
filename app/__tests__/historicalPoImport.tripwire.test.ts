// /app/__tests__/historicalPoImport.tripwire.test.ts
//
// Slice 6.13 (2026-05-22) — Source-text tripwires for the historical
// PurchaseOrder → BuyerDraftBuy import path. The handler is thin and
// the pure helper is A-graded; this file enforces the wiring
// conventions that future refactors might accidentally drop.

import fs from "fs";
import path from "path";

const HANDLER_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/pages/api/admin/buyer-drafts/import-purchase-order.ts"),
  "utf8",
);

const SEARCH_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/pages/api/admin/buyer-drafts/search-purchase-orders.ts"),
  "utf8",
);

const HELPER_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/lib/historicalPoImport.ts"),
  "utf8",
);

const SIBLINGS_API_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/pages/api/admin/buyer-drafts/find-sibling-pos.ts"),
  "utf8",
);

const SIBLINGS_HELPER_SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/lib/historicalPoSiblings.ts"),
  "utf8",
);

describe("historicalPoImport handlers — source-text tripwires", () => {
  it("import handler is ADMIN-gated", () => {
    expect(HANDLER_SRC).toMatch(/requireAuthWithRole\(\["ADMIN"\]/);
  });

  it("search handler is ADMIN-gated", () => {
    expect(SEARCH_SRC).toMatch(/requireAuthWithRole\(\["ADMIN"\]/);
  });

  it("import handler pre-checks idempotency via the @unique realPoId on the M:N join", () => {
    // Slice 6.14: the handler looks up an existing BuyerDraftPoRealPoLink
    // by realPoId (@unique) BEFORE inserting. If the pre-check is
    // dropped, the @unique constraint still rejects the insert, but the
    // UX is worse (Prisma error vs friendly 409 with alreadyImported
    // payload).
    expect(HANDLER_SRC).toMatch(/buyerDraftPoRealPoLink\.findUnique/);
    expect(HANDLER_SRC).toMatch(/realPoId:\s*purchaseOrderId/);
  });

  it("import handler refuses CANCELLED purchase orders", () => {
    // CANCELLED POs are not real buys; importing them would pollute the
    // performance report's denominators.
    expect(HANDLER_SRC).toMatch(/status\s*===\s*"CANCELLED"/);
  });

  it("import handler wraps the inserts in a single Prisma transaction", () => {
    // Without a transaction, a partial failure leaves an orphan
    // BuyerDraftPurchaseOrder row without items — looks like a buyer-
    // typed draft, breaks the @unique idempotency invariant on retry.
    expect(HANDLER_SRC).toMatch(/prisma\.\$transaction/);
  });

  it("import handler delegates the per-row shape to the pure helper", () => {
    expect(HANDLER_SRC).toMatch(/buildImportFromPurchaseOrder/);
    expect(HELPER_SRC).toMatch(/export function buildImportFromPurchaseOrder/);
  });

  it("search handler excludes CANCELLED POs by default", () => {
    // The search endpoint feeds the modal; if it returns CANCELLED POs
    // the user can pick one and then get a 400 at import time.
    expect(SEARCH_SRC).toMatch(/not:\s*"CANCELLED"/);
  });

  it("search handler surfaces 'already imported' via the back-relation", () => {
    expect(SEARCH_SRC).toMatch(/buyerDraftLink/);
  });

  it("imported draft items carry the HISTORICAL_PO_IMPORT source stamp", () => {
    // The Slice 6.1 display fallback + the workbench filtering rely on
    // this source tag to distinguish auto-imported drafts from buyer-
    // typed ones.
    expect(HELPER_SRC).toMatch(/source:\s*"HISTORICAL_PO_IMPORT"/);
  });

  it("imported draft items get FULFILLED status (real PO already exists)", () => {
    expect(HELPER_SRC).toMatch(/status:\s*"FULFILLED"/);
  });

  it("helper skips qty <= 0 line items (rule 31)", () => {
    // Zero-quantity the POS rows are cancelled lines. Helper must not
    // import them as qty=1 phantoms — that would inflate the buy
    // performance report's "qty ordered" totals.
    expect(HELPER_SRC).toMatch(/zero-quantity/);
    expect(HELPER_SRC).toMatch(/rawQty\s*<=\s*0/);
  });
});

describe("historicalPoSiblings — source-text tripwires", () => {
  it("siblings API is ADMIN-gated", () => {
    expect(SIBLINGS_API_SRC).toMatch(/requireAuthWithRole\(\["ADMIN"\]/);
  });

  it("siblings API scopes the candidate window by vendor + ± WINDOW_DAYS", () => {
    // Bounded scan: same vendor, near date. A naïve cross-vendor scan
    // would surface false positives + slow the modal.
    expect(SIBLINGS_API_SRC).toMatch(/WINDOW_DAYS/);
    expect(SIBLINGS_API_SRC).toMatch(/vendorId:\s*source\.vendorId/);
    expect(SIBLINGS_API_SRC).toMatch(/orderDate:\s*\{\s*gte:\s*minDate,\s*lte:\s*maxDate/);
  });

  it("siblings API excludes CANCELLED POs", () => {
    expect(SIBLINGS_API_SRC).toMatch(/status:\s*\{\s*not:\s*"CANCELLED"/);
  });

  it("siblings helper excludes already-imported candidates", () => {
    expect(SIBLINGS_HELPER_SRC).toMatch(/alreadyImportedToBuyId/);
  });

  it("siblings helper drops zero-overlap candidates", () => {
    // No shared partNos means it's almost certainly a different buy.
    // Surfacing it would be noise.
    expect(SIBLINGS_HELPER_SRC).toMatch(/overlap\s*===\s*0/);
  });

  it("siblings helper sorts by overlapCount DESC then fullyContained DESC then orderDate ASC", () => {
    // The ordering signals "most-likely sibling first."
    expect(SIBLINGS_HELPER_SRC).toMatch(/overlapCount/);
    expect(SIBLINGS_HELPER_SRC).toMatch(/fullyContainedBySource/);
    expect(SIBLINGS_HELPER_SRC).toMatch(/orderDate\.getTime/);
  });
});
