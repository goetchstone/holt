// /app/__tests__/ordoriteImportRunners.regression.test.ts
//
// Tripwire tests for the Ordorite-adapter import runners. Each `it`
// block guards a specific bug pattern that has shipped to prod and
// silently failed before (in the upstream FC deployment this adapter
// was ported from). The tests deliberately READ THE SOURCE FILE, not
// Prisma-mock-the-runner, because:
//
//   1. The runners call ~30 prisma methods in a $transaction;
//      faithfully mocking that surface for end-to-end tests requires
//      integration-test infrastructure.
//
//   2. The bugs caught in prod were specific code patterns
//      (deleteMany on a FK target, missing relation form on Prisma 7
//      input). Source-text tripwires catch *exactly* the regression
//      we know hurts, with zero infrastructure cost.
//
// Postgres-backed integration tests subsume some of these over time;
// until then these tripwires are the contract.
//
// Layout note (Holt port): the runner lives at
// src/lib/adapters/ordorite/runners.ts; Ordorite-specific helpers
// (incl. findProduct autoCreate) at src/lib/adapters/ordorite/shared.ts;
// source-agnostic customer dedup at src/lib/importHelpers.ts (re-exported
// by shared.ts). Prisma fields were de-branded: ordoriteCuscode →
// externalCustomerCode, CustomerOrdoriteId → CustomerExternalId, etc.

import { readFileSync } from "fs";
import path from "path";

const RUNNER_PATH = path.resolve(__dirname, "../src/lib/adapters/ordorite/runners.ts");
const SHARED_PATH = path.resolve(__dirname, "../src/lib/adapters/ordorite/shared.ts");
const IMPORT_HELPERS_PATH = path.resolve(__dirname, "../src/lib/importHelpers.ts");
const ORCHESTRATOR_PATH = path.resolve(
  __dirname,
  "../src/lib/adapters/ordorite/orchestrator.ts",
);

const RUNNER_SRC = readFileSync(RUNNER_PATH, "utf8");
const SHARED_SRC = readFileSync(SHARED_PATH, "utf8");
const HELPERS_SRC = readFileSync(IMPORT_HELPERS_PATH, "utf8");
const ORCHESTRATOR_SRC = readFileSync(ORCHESTRATOR_PATH, "utf8");

describe("ordorite adapter runners regression guards", () => {
  // 2026-04-25: SBOM38784 had OrderLineItem rows that were referenced by
  // InvoiceLineItem (FK orderLineItemId). Sales runner's orphan-cleanup
  // tried `deleteMany` on those lines when today's CSV had fewer rows
  // for that order than a prior run. FK violation on first delete →
  // Postgres aborted the whole batch transaction → 30 subsequent orders
  // failed with "current transaction is aborted." User saw "10 orders
  // attempted, 0 with full data" because payments-import had created
  // stub SalesOrder rows with just orderno + null orderDate, and sales
  // import never got around to filling them in. Fix in FC PR #121:
  // replace deleteMany with updateMany SET lineItemStatus = "CANCELLED".
  // Reports already filter cancelled lines (cancelled-line rule), so
  // numbers stay correct; the FK reference survives.
  it("does not deleteMany on OrderLineItem (FK violation cascade)", () => {
    expect(RUNNER_SRC).not.toMatch(/\borderLineItem\.deleteMany\b/);
    expect(RUNNER_SRC).not.toMatch(/\btx\.orderLineItem\.deleteMany\b/);
  });

  // The replacement must mark orphan lines as CANCELLED so the report
  // filtering rule takes them out of all totals.
  it("uses lineItemStatus='CANCELLED' for orphan cleanup", () => {
    expect(RUNNER_SRC).toMatch(/lineItemStatus:\s*["']CANCELLED["']/);
  });

  // 2026-04-25: findProduct.autoCreate was supplying scalar foreign-keys
  // (vendorId: 229) but Prisma 7 with required relations (`vendor:
  // Vendor @relation`) demands the relation form when ANY required
  // relation isn't fully provided. The error was misleading: "Argument
  // `vendor` is missing" even with vendorId set. Fix in FC PR #120: use
  // the connect form for vendor + department + category. Lives in
  // adapters/ordorite/shared.ts in the Holt layout.
  it("findProduct.autoCreate uses connect form for vendor relation", () => {
    // Find the autoCreate block and assert it references the relation form
    const autoCreateBlock = SHARED_SRC.match(/if \(opts\.autoCreate.*?\)[\s\S]{0,2000}\}/);
    expect(autoCreateBlock).not.toBeNull();
    if (autoCreateBlock) {
      expect(autoCreateBlock[0]).toMatch(/vendor:\s*\{\s*connect:/);
      expect(autoCreateBlock[0]).toMatch(/department:\s*\{\s*connect:/);
      expect(autoCreateBlock[0]).toMatch(/category:\s*\{\s*connect:/);
    }
  });

  // The autoCreate must NEVER use bare scalar FKs (vendorId: 1) for the
  // required relations because Prisma 7's input matcher rejects mixed
  // forms when any other required relation is missing. If a future
  // refactor "simplifies" this back to scalars, this test fails.
  it("findProduct.autoCreate does not use bare scalar foreign keys", () => {
    const autoCreateBlock = SHARED_SRC.match(/if \(opts\.autoCreate.*?\)[\s\S]{0,2000}\}/);
    expect(autoCreateBlock).not.toBeNull();
    if (autoCreateBlock) {
      // Allow vendorId/departmentId/categoryId in the surrounding
      // resolution (e.g. `const vendorId = ...`) but not as create-data
      // keys. We check the createData object shape specifically.
      const createDataBlock = autoCreateBlock[0].match(/createData[^=]*=[\s\S]{0,1000}\};/);
      if (createDataBlock) {
        // These shouldn't appear as object property keys in createData
        expect(createDataBlock[0]).not.toMatch(/^\s*vendorId:\s/m);
        expect(createDataBlock[0]).not.toMatch(/^\s*departmentId:\s/m);
        expect(createDataBlock[0]).not.toMatch(/^\s*categoryId:\s/m);
      }
    }
  });

  // Holt port (2026-06): the 3 PO-creating runners used to write
  // `vendorId: vendorId || 0` when a row had no Supplier — an FK
  // violation hazard (no Vendor row with id 0 exists). The port replaced
  // the fallback with `ensureUnknownVendorId(prisma)`, which find-or-
  // creates the shared "Unknown Vendor" row. Guard against a future
  // re-sync from FC reintroducing the `|| 0` shape.
  it("PO-create fallbacks use ensureUnknownVendorId, never vendorId || 0", () => {
    expect(RUNNER_SRC).not.toMatch(/vendorId:\s*vendorId\s*\|\|\s*0\b/);
    expect(RUNNER_SRC).toMatch(/ensureUnknownVendorId/);
    // All 3 PO-create sites (purchase-orders, inbound-items, temp-items)
    // must use the helper — a partial sweep leaves the hazard live.
    const fallbackSites = RUNNER_SRC.match(/ensureUnknownVendorId\(prisma\)/g) ?? [];
    expect(fallbackSites.length).toBeGreaterThanOrEqual(3);
  });

  // 2026-05-22: same-day-rewrite cleanup over-cancelled SBOM39876 base
  // lines 2 + 4 ($2,078 OS sales gap). The rewrite (SBOM39876 - A) was
  // a penny-only price-tweak on one line; customer kept everything;
  // heuristic couldn't tell the difference between this case and the
  // CHOM1726 drop case (data shapes are identical). Fix: add an operator
  // override `SalesOrder.skipSameDayRewriteCleanup`. When TRUE, the
  // cleanup short-circuits for that base order.
  //
  // Tripwire: the guard must be present in cleanupOneRewriteChain. If a
  // refactor accidentally drops it, the same over-cancellation pattern
  // recurs.
  it("cleanupOneRewriteChain respects SalesOrder.skipSameDayRewriteCleanup flag", () => {
    // Find the cleanupOneRewriteChain function body
    const fnBody = RUNNER_SRC.match(/async function cleanupOneRewriteChain[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // Must select the flag from the base order
    expect(body).toMatch(/skipSameDayRewriteCleanup:\s*true/);
    // Must short-circuit when the flag is set
    expect(body).toMatch(/base\.skipSameDayRewriteCleanup/);
  });

  // 2026-05-22 (second incident, same day): the OS sales gap that FC
  // PR #320 patched per-order via the skip flag turned out to have a
  // deeper root cause. Audit query against the 5/22 backup: 193 of 195
  // same-day rewrites have a matching SBOA/CHOA/GTOA accounting return
  // for the same customer + orderDate, but the runner's
  // `swapToReturnPrefix` (SBOM39876 -> SBOA39876) looked for an orderno
  // that never exists. Real example: CHOM1726's return is CHOA010045;
  // SBOM38847's is SBOA013491. The numbers don't mirror.
  //
  // Consequence: `returnLines` was [] in ~99% of same-day rewrites,
  // gate 2 of `findDroppedBaseLineIds` was trivially satisfied, and
  // cancellation decisions fell back to position + rewrite-partNo
  // alone. CHOM1726 came out right by coincidence; SBOM39876 didn't.
  //
  // Fix: look up the return by (customerId, orderDate, prefix), not by
  // exact orderno swap. Ordorite return ordernos use a separate numeric
  // sequence from the base orders.
  //
  // Tripwires below: the runner MUST query for the return by
  // customerId + orderDate with the SBOA/CHOA/etc. prefix, NOT by exact
  // orderno. If a future refactor reintroduces the orderno-swap shape
  // these will fail.
  it("cleanupOneRewriteChain looks up returns by (customerId, orderDate, prefix), not orderno swap", () => {
    const fnBody = RUNNER_SRC.match(/async function cleanupOneRewriteChain[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // Must NOT look up by an exact returnOrderno computed from a swap
    expect(body).not.toMatch(/swapToReturnPrefix\(/);
    expect(body).not.toMatch(/orderno:\s*returnOrderno/);
    // Must use the helper that loads by (customerId, orderDate, prefix)
    expect(body).toMatch(/loadSameDayReturnLines\(/);
    expect(body).toMatch(/sameDayReturnPrefixFor\(/);
  });

  it("loadSameDayReturnLines uses customerId + orderDate + startsWith prefix", () => {
    // Source-text level: the helper must exist and the where clause must
    // include all three identifiers. We check at the file level because
    // the function body has nested braces that confuse non-greedy regex
    // slicing.
    expect(RUNNER_SRC).toMatch(/async function loadSameDayReturnLines/);
    expect(RUNNER_SRC).toMatch(/customerId:\s*args\.customerId/);
    expect(RUNNER_SRC).toMatch(/orderDate:\s*args\.orderDate/);
    expect(RUNNER_SRC).toMatch(/startsWith:\s*args\.prefix/);
  });

  it("sameDayReturnPrefixFor maps store-prefix correctly + rejects non-OM", () => {
    expect(RUNNER_SRC).toMatch(/function sameDayReturnPrefixFor/);
    // The OA suffix appears in the return prefix construction.
    expect(RUNNER_SRC).toMatch(/\$\{match\[1\]\}OA/);
    // Must require the input orderno to be the OM (merchandise) form.
    // Source contains the regex `/^([A-Z]{2})OM\d/`. We match the
    // distinctive `)OM` substring which only appears in this regex.
    expect(RUNNER_SRC).toMatch(/\)OM\\d/);
  });

  // 2026-05-22 follow-up: the >= 50% safety guard from FC PR #321 was
  // REMOVED after it produced 12 false-positive uncancellations at the
  // exact 50% boundary (1-of-2 drops looked the same as 1-tweak +
  // 1-kept). Owner-reported OS 5/1-5/20 = $1,100 over Ordorite, traced
  // to SBOM39006's BAT-MU01 wrongly uncancelled. The price-tweak shape
  // is now handled solely by the operator flag
  // (SalesOrder.skipSameDayRewriteCleanup). FC migration
  // 20260522d_recancel_wrongly_restored_drops re-cancelled the 12
  // wrongly-restored drop cases.
  //
  // Tripwire: the function must NOT reintroduce a percentage-based
  // safety guard that would catch true drops at the 50% boundary.
  it("cleanupOneRewriteChain does NOT use a >= 50% percentage-based safety guard", () => {
    const fnBody = RUNNER_SRC.match(/async function cleanupOneRewriteChain[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // The >=0.5 pattern was the symptom — must stay out
    expect(body).not.toMatch(/>=\s*0\.5/);
    // The activeBaseLines variable was only used by the guard
    expect(body).not.toMatch(/activeBaseLines/);
  });

  // 2026-05-22 Slice 6.14 — `runPurchaseOrdersImport` must call
  // `autoLinkBuyerDraftPosToRealPos` as a post-import sweep so newly-
  // imported real POs auto-attach to existing buyer-draft POs. The
  // forward-flow workflow depends on this; without it the buyer has to
  // manually link every PO via the historical-PO-import modal even for
  // POs they just drafted.
  it("runPurchaseOrdersImport calls autoLinkBuyerDraftPosToRealPos post-batch", () => {
    expect(RUNNER_SRC).toMatch(
      /results\.buyerDraftPoAutoLinked\s*=\s*await autoLinkBuyerDraftPosToRealPos/,
    );
    expect(RUNNER_SRC).toMatch(/async function autoLinkBuyerDraftPosToRealPos/);
  });

  it("autoLinkBuyerDraftPosToRealPos delegates planning to lib/buyerDraftPoAutoLink", () => {
    expect(RUNNER_SRC).toMatch(/import \{ planPoAutoLinks \} from "@\/lib\/buyerDraftPoAutoLink"/);
    expect(RUNNER_SRC).toMatch(/planPoAutoLinks\(/);
  });

  it("autoLinkBuyerDraftPosToRealPos filters by `buyerDraftLink: null` (idempotent)", () => {
    // Without this filter the sweep would attempt to re-link every real
    // PO on every run and rely on the unique constraint to bounce
    // duplicates — wasteful + noisy in logs.
    const fnBody = RUNNER_SRC.match(
      /async function autoLinkBuyerDraftPosToRealPos[\s\S]*?\n\}/,
    );
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    expect(fnBody[0]).toMatch(/buyerDraftLink:\s*null/);
  });

  // 2026-05-21: runTempItemsImport previously hardcoded `status:
  // "CONFIRMED"` when creating new PurchaseOrders, ignoring Ordorite's
  // `Postatus` column. The runner had never delivered data (router
  // mismatch on Prior_Day_Temp_Items → renamed Temp_Purchase_Orders
  // 2026-05-20, fixed in FC PR #314) so no real history was affected,
  // but the moment the rename landed every temp PO would have been
  // stored as CONFIRMED — indistinguishable from real confirmed POs.
  // Fix: use derivePOStatus(row.Postatus) like the 3 other PO-creating
  // runners. PO_STATUS_MAP now maps "temporary" → "DRAFT".
  it("runTempItemsImport uses derivePOStatus for new PO status (not hardcoded CONFIRMED)", () => {
    // Find the runTempItemsImport function body
    const fnBody = RUNNER_SRC.match(/export async function runTempItemsImport[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // Must reference derivePOStatus for the temp-PO create branch
    expect(body).toMatch(/derivePOStatus\(row\["Postatus"\]/);
    // The CONFIRMED hardcode at PO create-time must be gone
    const hardcoded = body.match(/status:\s*"CONFIRMED"/);
    expect(hardcoded).toBeNull();
  });

  // 2026-04-25: ReceivingRecord.receiverUserId is a FK to User.id (CUID
  // string), not the email address. The runner was passing userEmail
  // directly which always failed FK constraint when the email didn't
  // happen to match a User.id value. Fix in FC PR #120: introduced
  // resolveImportUserId() helper that looks up User by email and caches
  // the resolved id for the runner's lifetime.
  it("uses resolveImportUserId helper for ReceivingRecord.receiverUserId", () => {
    expect(RUNNER_SRC).toMatch(/resolveImportUserId/);
    // The bare assignment of userEmail to receiverUserId would be the
    // regression. Allow `receiverUserId: receiverUserId` (helper output)
    // but flag direct email use.
    const directEmailUse = RUNNER_SRC.match(/receiverUserId:\s*userEmail\b/);
    expect(directEmailUse).toBeNull();
  });

  // Holt port: resolveImportUserId's fallback for non-email createdBy
  // values (cron runners pass labels like "auto-import") must use the
  // de-branded placeholder address. A re-sync from FC would carry the
  // upstream domain back in.
  it("resolveImportUserId uses the Holt placeholder automation email", () => {
    expect(RUNNER_SRC).toMatch(/"import-runner@holt\.local"/);
  });

  // 2026-04-25: runCustomerImport's email-enrichment update could fail
  // with `Unique constraint failed on (email)` when two Ordorite
  // customers shared an email or a customer was merged upstream. Fix in
  // FC PR #120: check for collision first, log to errors[], skip rather
  // than crash the batch.
  it("customer email enrichment guards against unique-constraint collision", () => {
    // The fix introduces a findUnique({ where: { email } }) check
    // before the update. If a future refactor removes that guard, this
    // test fails.
    const emailEnrichBlock = RUNNER_SRC.match(
      /Enrich email if the customer record is missing one[\s\S]{0,1600}/,
    );
    expect(emailEnrichBlock).not.toBeNull();
    if (emailEnrichBlock) {
      expect(emailEnrichBlock[0]).toMatch(/findUnique[\s\S]*?email/);
    }
  });

  // 2026-05-20: Ordorite CSV exports can carry a UTF-8 BOM on the first
  // column header. Without stripping it, the first column key comes back
  // as `﻿Cuscode` / `﻿Active` and every lookup of that header
  // misses — in FC this spawned duplicate Customer records for 95
  // anonymous-stub customers (the manual csv-parser route) and would
  // break the item export's `Active` column. Holt has no csv-parser
  // route — all adapter ingestion flows through the orchestrator's
  // Papa.parse, which must keep its BOM-stripping transformHeader.
  it("orchestrator strips BOM from CSV headers (transformHeader)", () => {
    // The transformHeader callback must be present in the Papa.parse
    // invocation.
    expect(ORCHESTRATOR_SRC).toMatch(
      /Papa\.parse\s*\([\s\S]{0,600}?transformHeader[\s\S]{0,200}?h\.replace\s*\(/,
    );
    // The replace regex must include the literal BOM character (U+FEFF)
    // — that's the actual byte sequence we're stripping. If a future
    // refactor "cleans up" the regex and drops the BOM, this catches it.
    const transformHeaderBlock = ORCHESTRATOR_SRC.match(
      /transformHeader[\s\S]{0,400}?h\.replace\s*\([^)]+\)/,
    );
    expect(transformHeaderBlock).not.toBeNull();
    if (transformHeaderBlock) {
      // U+FEFF is the BOM. Match the literal character.
      expect(transformHeaderBlock[0]).toMatch(/﻿/);
    }
  });

  // 2026-05-20: Daily Quote Report runner (`runQuotesImport` +
  // `reconcileExistingQuoteOrder`) didn't read Cuscode. Result: 225 of
  // 228 April-onwards quotes had no external-customer-id link AND no
  // SalesOrder.externalCustomerCode populated. The sales runner papered
  // over this when a quote was promoted to ORDER (it overwrote the row
  // including externalCustomerCode), but quotes that never promoted
  // stayed unhydrated forever — 14 customers from the 5/20 audit had
  // this shape. Fix: both create-new and reconcile-existing paths must
  // extract Cuscode, pass it to findOrCreateCustomer (so the
  // CustomerExternalId upsert at end of findOrCreateCustomer writes
  // the link), and set SalesOrder.externalCustomerCode.
  it("runQuotesImport create-new path extracts Cuscode and writes externalCustomerCode", () => {
    // Extract the runQuotesImport function body and assert each
    // requirement inside it.
    const fnBody = RUNNER_SRC.match(/export async function runQuotesImport[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // 1) extracts cuscode from firstRow
    expect(body).toMatch(/const cuscode = safeString\(firstRow\.Cuscode\)/);
    // 2) passes cuscode to findOrCreateCustomer
    expect(body).toMatch(/findOrCreateCustomer[\s\S]{0,400}?cuscode,/);
    // 3) writes externalCustomerCode on the new SalesOrder
    expect(body).toMatch(/tx\.salesOrder\.create\([\s\S]{0,800}?externalCustomerCode/);
  });

  it("reconcileExistingQuoteOrder extracts Cuscode and updates externalCustomerCode", () => {
    // Extract just the body of reconcileExistingQuoteOrder so each
    // assertion below is scoped to that function (the broader RUNNER_SRC
    // contains the same patterns inside `runQuotesImport` too — we want
    // them in BOTH places but the proof needs separate matchers).
    const fnBody = RUNNER_SRC.match(/async function reconcileExistingQuoteOrder[\s\S]*?\n\}/);
    expect(fnBody).not.toBeNull();
    if (!fnBody) return;
    const body = fnBody[0];
    // 1) extracts cuscode from firstRow
    expect(body).toMatch(/const cuscode = safeString\(firstRow\.Cuscode\)/);
    // 2) calls findOrCreateCustomer with cuscode
    expect(body).toMatch(/findOrCreateCustomer[\s\S]{0,400}?cuscode,/);
    // 3) writes externalCustomerCode on the SalesOrder update
    expect(body).toMatch(/externalCustomerCode/);
  });

  // 2026-05-20: manual SH_Customers.csv upload created duplicate "Patti"
  // and "Diane" rows. The existing single-name customers had stored
  // their lastName as NULL (or absent), but findOrCreateCustomer's
  // by-name lookup used `lastName: ""` to match single-name CSV rows.
  // Postgres three-valued logic: `NULL != ''` evaluates to NULL, not
  // TRUE, so the existing NULL-lastName rows did not match — fell
  // through to create-new — duplicate. Fix in FC PR #305: when
  // splitCustomerName returns lastName=null, use
  // OR: [{ lastName: null }, { lastName: "" }] so we match either form.
  it("findOrCreateCustomer matches single-name customers with NULL or empty lastName", () => {
    // Find the by-name branch (the third lookup pass after cuscode and
    // email+name). Its where clause must use OR for the null branch.
    const byNameBranch = HELPERS_SRC.match(
      /!customer\s*&&\s*customerName\s*\)\s*{[\s\S]{0,800}?customer\s*=\s*await\s+prisma\.customer\.findFirst/,
    );
    expect(byNameBranch).not.toBeNull();
    if (byNameBranch) {
      // Either explicit OR clause OR a ternary that produces one.
      expect(byNameBranch[0]).toMatch(/OR:\s*\[\s*{\s*lastName:\s*null\s*}/);
      expect(byNameBranch[0]).toMatch(/{\s*lastName:\s*""\s*}/);
    }
  });

  // 2026-05-05: salespeople sometimes typed their own staff email when
  // entering customer records in the POS. findOrCreateCustomer's
  // email-match then merged every subsequent customer with that same
  // staff email into the FIRST record, clustering ~138 distinct
  // customers across ~20 records. Fix: skip email-based matching
  // whenever the email looks like an internal/staff email (the
  // company's own domain — COMPANY_EMAIL_DOMAIN in the Holt port).
  it("findOrCreateCustomer skips email match when isUntrustedMergeEmail is true", () => {
    const helpersSrc = HELPERS_SRC;
    expect(helpersSrc).toMatch(/export function isUntrustedMergeEmail/);
    // The match-by-email branch must be guarded by both the untrusted-
    // email check AND the customerName presence (rule tightened
    // 2026-05-06; see test below).
    expect(helpersSrc).toMatch(
      /if\s*\(\s*!customer\s*&&\s*email\s*&&\s*!isUntrustedMergeEmail\(email\)\s*&&\s*customerName\s*\)/,
    );
  });

  // 2026-05-06: marketing-staff donation incident. Even with
  // isUntrustedMergeEmail blocking company-domain emails, two unrelated
  // entities sharing a real external email could still wrongly merge
  // (a marketing person put their own gmail on a non-profit donation
  // entry — the non-profit then merged into the staffer's customer
  // card on a future quote). Fix: tighten the email match to require
  // the incoming customerName to match the existing record's
  // firstName + lastName. Email-only matches fall through to the
  // by-name lookup, which is name-strict by construction.
  it("findOrCreateCustomer email match also requires firstName + lastName equality", () => {
    const helpersSrc = HELPERS_SRC;
    // The findFirst call inside the email-guarded branch must include
    // firstName and lastName in its where clause.
    const emailBranch = helpersSrc.match(
      /!isUntrustedMergeEmail\(email\)\s*&&\s*customerName\s*\)\s*{[\s\S]{0,400}/,
    );
    expect(emailBranch).not.toBeNull();
    if (emailBranch) {
      expect(emailBranch[0]).toMatch(/findFirst/);
      expect(emailBranch[0]).toMatch(/firstName/);
      expect(emailBranch[0]).toMatch(/lastName/);
    }
  });

  it("runCustomerImport email enrichment skips untrusted emails", () => {
    // The enrichment block must guard with isUntrustedMergeEmail. If a
    // future refactor removes the guard, customers wrongly tagged with
    // a staff email would propagate that email back onto the existing
    // customer record, undoing the unmerge work.
    expect(RUNNER_SRC).toMatch(/!isUntrustedMergeEmail\(email\)/);
  });

  // 2026-04-28: runQuotesImport had an early-exit `continue` on the
  // existing-order branch -- only updated quoteCode/quoteDate, then
  // skipped the line-item create loop entirely. So any line-item edit
  // made in Ordorite after the first import never propagated. Bug
  // existed since 2026-03-26 (first commit of the runner) and surfaced
  // when SBOM38985 (a designer's quote) was reported missing line
  // items vs Ordorite. Fix: replace the early-exit with the same line-
  // item upsert + orphan-CANCELLED reconciliation pattern that
  // runSalesImport already uses.
  it("runQuotesImport reconciles line items on existing QUOTE orders (no early continue)", () => {
    // The reconciliation logic was extracted into reconcileExistingQuoteOrder
    // (Sonar S3776 cognitive-complexity cleanup, 2026-04-28). Tripwire
    // checks the helper exists AND is called from runQuotesImport's
    // existing-order branch — but ONLY when status === "QUOTE" (the
    // 2026-05-07 promoted-order guard).
    expect(RUNNER_SRC).toMatch(/async function reconcileExistingQuoteOrder/);

    const quotesFn = RUNNER_SRC.match(/export async function runQuotesImport[\s\S]*?\n}/);
    expect(quotesFn).not.toBeNull();
    if (!quotesFn) return;

    // The reconcile call must still be reachable from the existing-order
    // branch — checking the function body, not a specific block shape,
    // because the 2026-05-07 promoted-order guard added an early-continue
    // before the reconcile call.
    expect(quotesFn[0]).toMatch(/reconcileExistingQuoteOrder/);

    // 2026-05-07 promoted-order guard: there must be a status check that
    // skips reconciliation for non-QUOTE orders. Without this guard the
    // quote runner corrupts promoted orders' line items (SBOM39275 prod
    // recurrence).
    expect(quotesFn[0]).toMatch(/existing\.status\s*!==?\s*["']QUOTE["']/);

    // The helper itself must touch line items: upsert + orphan cancel.
    const helperFn = RUNNER_SRC.match(/async function reconcileExistingQuoteOrder[\s\S]*?\n}/);
    expect(helperFn).not.toBeNull();
    if (!helperFn) return;
    expect(helperFn[0]).toMatch(/orderLineItem\.update/);
    expect(helperFn[0]).toMatch(/orderLineItem\.create/);
    expect(helperFn[0]).toMatch(/lineItemStatus:\s*["']CANCELLED["']/);

    // 2026-05-07 rewrite-freeze (defense in depth): the helper itself
    // must guard orphan-cleanup with a baseHasRewrite check. Same shape
    // as runSalesImport. Without this, a future change that re-allows
    // this code path for non-QUOTE orders would re-introduce the bug.
    expect(helperFn[0]).toMatch(/baseHasRewrite/);
    expect(helperFn[0]).toMatch(/isRewriteOrder/);
  });

  // 2026-05-02: SBOM39275 (a $22,533 order) had line counts oscillate
  // across re-imports — Ordorite re-exported the CSV multiple times with
  // different row counts (17 → 22 → 17 → 29). Each shrink triggered
  // orphan-cleanup that set lineItemStatus to CANCELLED. Each subsequent
  // grow updated the now-cancelled lines' other fields but DID NOT reset
  // lineItemStatus back to ACTIVE. Net effect: 12 lines / $7,819
  // stranded as CANCELLED in our DB while the latest CSV (and Ordorite's
  // report) had them as real sales. Detailed Sales OS May 3 showed
  // $25,997 vs Ordorite $33,816.
  //
  // Fix: when updating an existing line whose lineItemStatus is
  // CANCELLED with NULL cancelReason (= orphan-cancelled, not user-
  // cancelled), reset to ACTIVE. User-cancelled lines (cancelReason
  // set) stay CANCELLED — that's deliberate intent.
  it("runSalesImport reactivates orphan-cancelled lines when CSV provides them", () => {
    const salesFn = RUNNER_SRC.match(/export async function runSalesImport[\s\S]*?\n}/);
    expect(salesFn).not.toBeNull();
    if (!salesFn) return;

    // existingLines select must include lineItemStatus + cancelReason
    // (otherwise we can't distinguish orphan-cancelled from user-
    // cancelled at update time).
    expect(salesFn[0]).toMatch(/lineItemStatus:\s*true/);
    expect(salesFn[0]).toMatch(/cancelReason:\s*true/);

    // The reactivation guard must check both fields together.
    expect(salesFn[0]).toMatch(/isOrphanCancelled/);
    expect(salesFn[0]).toMatch(/lineItemStatus\s*===\s*["']CANCELLED["']\s*&&\s*!.*cancelReason/);
    // And set lineItemStatus back to ACTIVE on update.
    expect(salesFn[0]).toMatch(/lineItemStatus:\s*["']ACTIVE["']/);
  });

  it("reconcileExistingQuoteOrder mirrors the reactivation guard", () => {
    const helperFn = RUNNER_SRC.match(/async function reconcileExistingQuoteOrder[\s\S]*?\n}/);
    expect(helperFn).not.toBeNull();
    if (!helperFn) return;

    expect(helperFn[0]).toMatch(/lineItemStatus:\s*true/);
    expect(helperFn[0]).toMatch(/cancelReason:\s*true/);
    expect(helperFn[0]).toMatch(/isOrphanCancelled/);
    expect(helperFn[0]).toMatch(/lineItemStatus:\s*["']ACTIVE["']/);
  });

  // 2026-05-05: SBOM39275 hit the same $7,819 gap a SECOND time, this time
  // through a different mechanism than 2026-05-02's line-count oscillation.
  // After the rewrite SBOM39275 - A was created on 5/4, Ordorite's daily
  // CSV permanently exports only 17 rows for the base (the items that
  // "stayed" — the rest live on the rewrite). Our orphan-cleanup
  // interpreted "DB has 29, CSV has 17" as "user removed 12 lines" and
  // cancelled lines 18-29 every single time. The day's auto-import ran 6x
  // and on every run silently re-cancelled lines 18-29 on the base.
  //
  // The cancelled-line filter then dropped them from every salesperson +
  // daily report, but Ordorite's own daily-by-store total for 5/3 still
  // includes the full base value (the rewrite's SBOA accounting return
  // on 5/4 nets the chain — rewrites keep the whole chain active).
  // Result: our 5/3 OS = $25,997 vs Ordorite's $33,816, gap $7,819 ==
  // sum of cancelled lines + the multi-qty unit-price overwrites on
  // lines 6/12/15 of the same order.
  //
  // Fix: when running orphan-cleanup, FIRST check whether a sibling
  // rewrite (`<orderno> - A`/`B`/`C`/`D`) exists. If yes, skip the
  // orphan-cancel entirely. The base order is "frozen" at its original
  // line set so daily-by-store totals reconcile against Ordorite. Per-
  // line UPDATEs still run, so a manual re-import of a corrected CSV
  // can refresh values, and the reactivation guard still brings back
  // any line the new CSV provides.
  it("runSalesImport skips orphan-cleanup when a rewrite sibling exists", () => {
    const salesFn = RUNNER_SRC.match(/export async function runSalesImport[\s\S]*?\n}/);
    expect(salesFn).not.toBeNull();
    if (!salesFn) return;

    // Must consult `baseHasRewrite` (or equivalent flag) before deciding
    // which lines are orphans. A naked `existingLines.filter(...)` with
    // no rewrite check fails this test.
    expect(salesFn[0]).toMatch(/baseHasRewrite/);

    // The check itself must (a) exclude rewrite orders themselves
    // (isRewriteOrder returns true → the rewrite IS a leaf, no further
    // descendants) and (b) query the DB for sibling orders.
    expect(salesFn[0]).toMatch(/isRewriteOrder\s*\(\s*orderno\s*\)/);
    expect(salesFn[0]).toMatch(/orderno:\s*\{\s*startsWith:\s*`\$\{orderno\}\s*-\s*`\s*\}/);

    // The orphan list must short-circuit to [] when the flag is set.
    expect(salesFn[0]).toMatch(/baseHasRewrite\s*\?\s*\[\]\s*:\s*existingLines\.filter/);
  });

  // ─── Same-day rewrite dropped-line cleanup (post-failure 2026-05-12) ─
  //
  // CHOM1726 (5/9/2026): base had 5 lines, rewrite kept 3, dropped 2
  // (lounge chairs + extra delivery = $1,109). The accounting return
  // only covered the kept items, so the dropped lines dangled as ACTIVE
  // and double-counted daily sales (ERP $4,415 vs Ordorite $3,306 — a
  // $1,109 delta). Fix: post-import sweep
  // (`cancelSameDayRewriteDroppedLines`) detects same-day rewrites and
  // cancels base lines whose lineNumber exceeds the rewrite's max
  // lineNumber. Pure detection lives in
  // `lib/adapters/ordorite/sameDayRewriteCleanup.ts`
  // (`findDroppedBaseLineIds`).

  it("imports findDroppedBaseLineIds from sameDayRewriteCleanup", () => {
    expect(RUNNER_SRC).toMatch(
      /import\s*\{\s*findDroppedBaseLineIds\s*\}\s*from\s*["']@\/lib\/adapters\/ordorite\/sameDayRewriteCleanup["']/,
    );
  });

  it("runs cancelSameDayRewriteDroppedLines as a post-import sweep", () => {
    // The function must exist AND be called at the end of runSalesImport
    // (before the final `return results`).
    expect(RUNNER_SRC).toMatch(/async function cancelSameDayRewriteDroppedLines\(/);
    expect(RUNNER_SRC).toMatch(/await cancelSameDayRewriteDroppedLines\(/);
  });

  it("same-day cleanup matches base + rewrite on equal orderDate (not just orderno)", () => {
    // The base lookup MUST include orderDate equality. If it only matched
    // on orderno, cross-day rewrites would lose their base — breaking the
    // existing rewrite-chain accounting invariant.
    // Per-chain logic lives in `cleanupOneRewriteChain` (extracted from
    // the loop to keep Sonar S3776 cog complexity in check).
    const fn = RUNNER_SRC.match(/async function cleanupOneRewriteChain[\s\S]*?\n\}/m);
    expect(fn).not.toBeNull();
    if (!fn) return;
    expect(fn[0]).toMatch(/orderno:\s*baseOrderno,?\s*orderDate:\s*rewrite\.orderDate/);
  });

  // ─── Pay-period attribution lock (Slice 2, 2026-05-29) ─────────────
  //
  // A confirmed (active) pay period freezes that designer's salesperson
  // attribution for orders dated in the period. The daily import must
  // NOT re-write `salesperson` from the CSV for those orders, or the
  // nightly run silently re-attributes a locked period ("bad numbers").
  // Enforced by extending the existing `correctedOrders` preserve with
  // a `lockedOrders` set built from active confirmations.
  it("runSalesImport loads active confirmations + builds a lockedOrders set", () => {
    expect(RUNNER_SRC).toMatch(
      /import\s*\{\s*loadActiveConfirmationsWithNames\s*\}\s*from\s*["'@\/]+lib\/payPeriodLockGuard["']/,
    );
    expect(RUNNER_SRC).toMatch(/const\s+lockedOrders\s*=\s*new Set\(/);
    // Must match by NAME or FK — an FK-only check would miss orders
    // whose salesPersonId is still NULL (the import writes the string;
    // the FK arrives later via the backfill sweep).
    expect(RUNNER_SRC).toMatch(/isOrderLockedByNameOrFk\(/);
  });

  it("runSalesImport preserves salesperson for locked-period orders", () => {
    // The preserve branch must OR in lockedOrders, not just
    // correctedOrders — otherwise the lock is a no-op for orders whose
    // FK happens to be null.
    expect(RUNNER_SRC).toMatch(
      /correctedOrders\.has\(orderno\)\s*\|\|\s*lockedOrders\.has\(orderno\)/,
    );
  });

  // 2026-06-04: PO-aging report showed POs as overdue with stale ESDs
  // (PON06999 had ESD 2026-01-13 in our DB while Ordorite's export sent
  // 2026-06-30). runInboundItemsImport gated the ESD update on
  // `!existingPO.expectedDelivery`, so it set the ESD once and then froze
  // it — never honoring Ordorite's reschedules. The import must ALWAYS
  // refresh expectedDelivery from the export (Ordorite is authoritative).
  it("runInboundItemsImport refreshes expectedDelivery on every import (no first-write freeze)", () => {
    expect(RUNNER_SRC).not.toMatch(
      /if\s*\(\s*expectedDate\s*&&\s*!existingPO\.expectedDelivery\s*\)/,
    );
  });

  // 2026-06-04: received/cancelled POs stayed on the inbound report because
  // Ordorite drops them from the inbound export but we never updated status
  // (export gap). Fix: stamp every PO in the export with the run time
  // (`lastSeenInInboundExport`); the report shows only POs from the latest
  // run, so dropped POs fall off. Must stamp on BOTH create + update paths.
  it("runInboundItemsImport stamps lastSeenInInboundExport on create + update", () => {
    const stamps = RUNNER_SRC.match(/lastSeenInInboundExport:\s*importRunAt/g) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(2);
  });

  // 2026-06-04: the per-batch PO-status recalc only re-evaluated POs whose
  // number appeared in that day's Received_Items file. A PO whose final receipt
  // landed out-of-band (historical backfill, receipt on a day its number wasn't
  // in the file) stayed CONFIRMED forever -- on the received list but never
  // flipped to RECEIVED_FULL. Fix: the recalc also sweeps every non-terminal PO
  // that already carries receiving records, so status self-heals on every
  // import. The straggler query must remain.
  it("runReceivedItemsImport sweeps non-terminal POs with receiving records (status self-heal)", () => {
    expect(RUNNER_SRC).toMatch(
      /status:\s*\{\s*notIn:\s*\[\s*["']RECEIVED_FULL["']\s*,\s*["']CANCELLED["']\s*\]\s*\}/,
    );
    expect(RUNNER_SRC).toMatch(/receivingRecords:\s*\{\s*some:\s*\{\}\s*\}/);
  });

  // 2026-06-04: the self-heal recalc must decide "line received" by QUANTITY,
  // not by "has any receiving record." Line-level counting flipped qty-partial
  // POs (PON07479, 38/59 units) to RECEIVED_FULL, which wrongly drops them off
  // the inbound report. The recalc must sum quantityReceived and compare to the
  // ordered quantity.
  it("runReceivedItemsImport classifies received lines by quantity, not by record presence", () => {
    expect(RUNNER_SRC).toMatch(/quantityReceived/);
    expect(RUNNER_SRC).toMatch(/received\s*>=\s*Number\(line\.orderedQuantity\)/);
  });
});
