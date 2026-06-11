// /app/__tests__/integration/quotesReconcile.integration.test.ts
//
// PHASE 0.6.3 — first conversion of a mocked-Prisma placeholder test
// to a real-DB integration test. This file replaces the orchestration
// portion of __tests__/ordoriteImportRunners.quotesReconcile.test.ts;
// the pure-helper buildQuoteLineData tests in that file have no I/O
// and stay where they are.
//
// Why this conversion came first: the underlying code path bit us on
// 2026-04-23 (the rewrite-cancel rollback). Mocked tests didn't catch
// the misbehavior because the mocks behaved differently than Postgres
// did. The same-shape bug class is what Phase 0.6 exists to prevent.
//
// What this file covers (matches the original mocked test scenarios
// PLUS adds two real-DB-only checks the mocks couldn't):
//
//   1. 0 existing + CSV has 3 → 3 created
//   2. 3 existing + CSV has 5 → 3 updated + 2 created (growth)
//   3. 5 existing + CSV has 3 → 3 updated + 2 cancelled (shrinkage)
//   4. SBOM38985 reproduction: 1 existing + CSV has 4 → 1 updated + 3 created
//   5. (NEW, real-DB only) Idempotency: re-running the same CSV produces
//      identical state (no duplicate line items, no spurious cancellations)
//   6. (NEW, real-DB only) Cancelled lines are NOT re-created on re-import:
//      a previously-CANCELLED line stays CANCELLED even if the CSV omits
//      it, rather than the runner trying to insert a new row at the same
//      lineNumber and tripping a unique-constraint violation.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runQuotesImport } from "@/lib/adapters/ordorite/runners";

const ORDERNO = "SBOM38985";

function csvRow(orderno: string, partNo: string, qty = 1, price = 100): Record<string, unknown> {
  return {
    Orderno: orderno,
    Quotecode: "Q-1",
    Orderdate: "2026-04-21",
    Customer: "Test Customer",
    Email: "test@example.com",
    Company: "Old Saybrook",
    Salesperson: "Kim Dransfield",
    Status: "Open",
    "Part No": partNo,
    "Product Name": `Product ${partNo}`,
    Orderqty: qty,
    "Sellingprice Exvat": price,
  };
}

/**
 * Seed the test DB with an existing QUOTE order having `lineCount`
 * line items at lineNumbers 1..N. Returns the created order id so the
 * test can assert against it.
 */
async function seedExistingQuote(lineCount: number): Promise<number> {
  const customer = await prisma.customer.create({
    data: { firstName: "Test", lastName: "Customer", email: "test@example.com" },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: ORDERNO,
      status: "QUOTE",
      orderDate: new Date("2026-04-21"),
      customerId: customer.id,
      storeLocation: "Old Saybrook",
      salesperson: "Kim Dransfield",
      lineItems: {
        create: Array.from({ length: lineCount }, (_, i) => ({
          lineNumber: i + 1,
          partNo: `EXISTING-${i + 1}`,
          productName: `Existing line ${i + 1}`,
          netPrice: 100,
          cost: 100,
          orderedQuantity: 1,
          lineItemStatus: "ACTIVE",
        })),
      },
    },
  });
  return order.id;
}

describe("runQuotesImport — line-item reconciliation (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("0 existing + CSV has 3 → 3 created", async () => {
    // No existing order — the runner will create the SalesOrder
    // shell + customer + 3 line items.
    const csv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
    ];

    const result = await runQuotesImport(csv);

    expect(result.errors).toEqual([]);
    expect(result.quotesCreated).toBe(1);
    expect(result.lineItemsCreated).toBe(3);
    expect(result.lineItemsCancelled).toBe(0);

    // Observe the actual DB state — that's the whole point of this test.
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.partNo)).toEqual(["PART-A", "PART-B", "PART-C"]);
    expect(lines.every((l) => l.lineItemStatus === "ACTIVE")).toBe(true);
  });

  it("3 existing + CSV has 5 → 3 updated + 2 created (growth)", async () => {
    await seedExistingQuote(3);
    const csv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
      csvRow(ORDERNO, "PART-D"),
      csvRow(ORDERNO, "PART-E"),
    ];

    const result = await runQuotesImport(csv);

    expect(result.errors).toEqual([]);
    expect(result.lineItemsUpdated).toBe(3);
    expect(result.lineItemsCreated).toBe(2);
    expect(result.lineItemsCancelled).toBe(0);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(5);
    // Lines 1-3 were updated to PART-A/B/C; 4-5 were created as PART-D/E.
    expect(lines.map((l) => l.partNo)).toEqual([
      "PART-A",
      "PART-B",
      "PART-C",
      "PART-D",
      "PART-E",
    ]);
    expect(lines.every((l) => l.lineItemStatus === "ACTIVE")).toBe(true);
  });

  it("5 existing + CSV has 3 → 3 updated + 2 cancelled (shrinkage)", async () => {
    await seedExistingQuote(5);
    const csv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
    ];

    const result = await runQuotesImport(csv);

    expect(result.errors).toEqual([]);
    expect(result.lineItemsUpdated).toBe(3);
    expect(result.lineItemsCreated).toBe(0);
    expect(result.lineItemsCancelled).toBe(2);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(5);
    // Lines 1-3 active with new partNos; 4-5 cancelled, partNos preserved.
    expect(lines[0]).toMatchObject({ lineNumber: 1, partNo: "PART-A", lineItemStatus: "ACTIVE" });
    expect(lines[1]).toMatchObject({ lineNumber: 2, partNo: "PART-B", lineItemStatus: "ACTIVE" });
    expect(lines[2]).toMatchObject({ lineNumber: 3, partNo: "PART-C", lineItemStatus: "ACTIVE" });
    expect(lines[3]).toMatchObject({ lineNumber: 4, lineItemStatus: "CANCELLED" });
    expect(lines[4]).toMatchObject({ lineNumber: 5, lineItemStatus: "CANCELLED" });
  });

  it("the SBOM38985 reproduction: 1 existing + CSV has 4 → 1 updated + 3 created", async () => {
    // Real failure-log scenario: SBOM38985 had 1 OrderLineItem in our DB
    // (Kaden Classics Motion Sofa). The POS had additional items that
    // were never propagated because of the early-exit bug. After the fix,
    // a re-import with the full POS line set should add the missing
    // items.
    await seedExistingQuote(1);
    const csv = [
      csvRow(ORDERNO, "AL-KAD-RO3-ST", 1, 7575), // existing (overwrites line 1)
      csvRow(ORDERNO, "PART-NEW-1"),
      csvRow(ORDERNO, "PART-NEW-2"),
      csvRow(ORDERNO, "PART-NEW-3"),
    ];

    const result = await runQuotesImport(csv);

    expect(result.errors).toEqual([]);
    expect(result.lineItemsUpdated).toBe(1);
    expect(result.lineItemsCreated).toBe(3);
    expect(result.lineItemsCancelled).toBe(0);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      lineNumber: 1,
      partNo: "AL-KAD-RO3-ST",
      lineItemStatus: "ACTIVE",
    });
    expect(lines[0].netPrice.toString()).toBe("7575");
  });

  it("(REAL-DB ONLY) idempotency: re-running the same CSV produces identical state", async () => {
    // Mocked tests can't catch this — they don't model the actual
    // unique-constraint behavior that would fire if the runner tried
    // to INSERT a duplicate line. Real-DB test catches both the
    // happy path AND the constraint enforcement.
    const csv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
    ];

    // First run — creates the order + 3 lines.
    const r1 = await runQuotesImport(csv);
    expect(r1.errors).toEqual([]);
    expect(r1.lineItemsCreated).toBe(3);

    // Snapshot DB state.
    const linesAfterFirst = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(linesAfterFirst).toHaveLength(3);

    // Second run with identical CSV — should update in-place, not
    // create duplicates, not cancel anything, not error.
    const r2 = await runQuotesImport(csv);
    expect(r2.errors).toEqual([]);
    expect(r2.lineItemsUpdated).toBe(3);
    expect(r2.lineItemsCreated).toBe(0);
    expect(r2.lineItemsCancelled).toBe(0);

    const linesAfterSecond = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    // Identical row count, identical lineNumbers, identical partNos.
    expect(linesAfterSecond).toHaveLength(3);
    expect(linesAfterSecond.map((l) => l.partNo)).toEqual(["PART-A", "PART-B", "PART-C"]);
    // Same row IDs — no INSERT happened on the second pass.
    expect(linesAfterSecond.map((l) => l.id)).toEqual(linesAfterFirst.map((l) => l.id));
  });

  it("(REAL-DB ONLY) shrinkage then re-growth: cancelled lines stay cancelled if CSV brings them back", async () => {
    // 5 existing → CSV has 3 (cancels 4+5) → CSV has 5 (would the
    // runner UPDATE lines 4+5 back to ACTIVE, or try to INSERT new
    // ones at those lineNumbers?). Real-DB shows the actual behavior;
    // the mock can't say either way because it doesn't model unique
    // constraints.
    await seedExistingQuote(5);

    // Step 1: shrink to 3.
    const shrinkCsv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
    ];
    await runQuotesImport(shrinkCsv);

    // Step 2: re-grow to 5 (different parts now in slots 4+5).
    const growCsv = [
      csvRow(ORDERNO, "PART-A2"),
      csvRow(ORDERNO, "PART-B2"),
      csvRow(ORDERNO, "PART-C2"),
      csvRow(ORDERNO, "PART-D2"),
      csvRow(ORDERNO, "PART-E2"),
    ];
    const r = await runQuotesImport(growCsv);

    expect(r.errors).toEqual([]);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: [{ lineNumber: "asc" }, { id: "asc" }],
    });

    // Phase 0.6.3 / 2026-04-30: this test originally documented the
    // BUGGY behavior — runner left slots 4+5 CANCELLED even when the
    // re-grow CSV brought them back, so the second CSV's PART-D2/E2
    // didn't land. The 2026-05-05 SBOM39275 incident ($7,819 stranded
    // in OS Detailed Sales for May 3) made this a real-money bug.
    //
    // Fix in `reconcileExistingQuoteOrder` + `runSalesImport`: when
    // updating an existing line whose lineItemStatus is CANCELLED
    // with NULL cancelReason (orphan-cancelled, not user-cancelled),
    // reset to ACTIVE on the same update. User-cancelled lines stay
    // CANCELLED — that's deliberate intent we don't undo.
    //
    // Expected outcome after fix: all 5 lines ACTIVE with the
    // re-grow CSV's parts (PART-A2/B2/C2/D2/E2). Slots 4+5 were
    // orphan-cancelled in step 1 (cancelReason IS NULL), so step 2
    // reactivates them with the new CSV data.
    const active = lines.filter((l) => l.lineItemStatus === "ACTIVE");
    expect(active).toHaveLength(5);
    expect(active.map((l) => l.partNo)).toEqual([
      "PART-A2",
      "PART-B2",
      "PART-C2",
      "PART-D2",
      "PART-E2",
    ]);

    const cancelled = lines.filter((l) => l.lineItemStatus === "CANCELLED");
    expect(cancelled).toHaveLength(0);
  });

  it("(REAL-DB ONLY) shrinkage then re-growth: USER-cancelled lines STAY cancelled", async () => {
    // Counterpart to the test above. If a user manually cancelled a
    // line via the API (cancelReason set to a string), and a later
    // CSV re-grows past that lineNumber, we must preserve the user's
    // intent. The reactivation guard checks `cancelReason IS NULL`
    // for that reason.
    await seedExistingQuote(5);

    const shrinkCsv = [
      csvRow(ORDERNO, "PART-A"),
      csvRow(ORDERNO, "PART-B"),
      csvRow(ORDERNO, "PART-C"),
    ];
    await runQuotesImport(shrinkCsv);

    // Simulate a user manually cancelling line 4 (orphan-cancelled →
    // user-cancelled by setting a reason). Real production code-path:
    // the manual line-item cancel endpoint sets cancelReason.
    await prisma.orderLineItem.updateMany({
      where: { salesOrder: { orderno: ORDERNO }, lineNumber: 4 },
      data: { cancelReason: "manual-cancel-test" },
    });

    const growCsv = [
      csvRow(ORDERNO, "PART-A2"),
      csvRow(ORDERNO, "PART-B2"),
      csvRow(ORDERNO, "PART-C2"),
      csvRow(ORDERNO, "PART-D2"),
      csvRow(ORDERNO, "PART-E2"),
    ];
    await runQuotesImport(growCsv);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: [{ lineNumber: "asc" }, { id: "asc" }],
    });

    // Line 4 (user-cancelled): stays CANCELLED, partNo updated to PART-D2.
    const line4 = lines.find((l) => l.lineNumber === 4);
    expect(line4?.lineItemStatus).toBe("CANCELLED");
    expect(line4?.cancelReason).toBe("manual-cancel-test");

    // Line 5 (orphan-cancelled): reactivated to ACTIVE with PART-E2.
    const line5 = lines.find((l) => l.lineNumber === 5);
    expect(line5?.lineItemStatus).toBe("ACTIVE");
    expect(line5?.partNo).toBe("PART-E2");
  });
});

/**
 * Cuscode hydration tests — added 2026-05-20 after audit found that
 * `runQuotesImport` was the only sales-side runner that didn't read
 * `Cuscode` from the CSV. 225 of 228 April-onwards quotes lacked
 * CustomerExternalId links + SalesOrder.externalCustomerCode because of
 * this. User added Cuscode to the Daily Quote Report export the same
 * day; these tests pin the new behavior.
 *
 * Bug class guarded: regression of the cuscode-extraction logic in
 * the quote runner. Both the create-new path AND the
 * reconcile-existing path must read Cuscode + link the customer +
 * write externalCustomerCode.
 */
describe("runQuotesImport — Cuscode hydration (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function csvRowWithCuscode(orderno: string, cuscode: string, partNo: string) {
    return { ...csvRow(orderno, partNo), Cuscode: cuscode };
  }

  it("new quote with Cuscode writes the CustomerExternalId link", async () => {
    const csv = [csvRowWithCuscode(ORDERNO, "SBCT-NEW-001", "PART-A")];

    const result = await runQuotesImport(csv);
    expect(result.errors).toEqual([]);
    expect(result.quotesCreated).toBe(1);

    // CustomerExternalId link written
    const link = await prisma.customerExternalId.findUnique({
      where: { externalId: "SBCT-NEW-001" },
      include: { customer: true },
    });
    expect(link).not.toBeNull();
    expect(link?.customer.firstName).toBe("Test");
    expect(link?.customer.lastName).toBe("Customer");

    // SalesOrder.externalCustomerCode populated
    const order = await prisma.salesOrder.findUnique({
      where: { orderno: ORDERNO },
      select: { externalCustomerCode: true, customerId: true },
    });
    expect(order?.externalCustomerCode).toBe("SBCT-NEW-001");
    expect(order?.customerId).toBe(link?.customerId);
  });

  it("existing quote without Cuscode hydrates on re-import once Cuscode arrives", async () => {
    // Simulate the 2026-05-20 audit shape: quote was originally
    // imported BEFORE the POS added Cuscode to the Daily Quote Report.
    // Customer exists, order linked to them, but no CustomerExternalId
    // entry and SalesOrder.externalCustomerCode is NULL.
    const existingId = await seedExistingQuote(2);
    const customerId = await prisma.salesOrder
      .findUnique({ where: { id: existingId }, select: { customerId: true } })
      .then((o) => o?.customerId);
    expect(customerId).not.toBeNull();
    // Pre-state: no CustomerExternalId entry, no externalCustomerCode on order
    expect(
      await prisma.customerExternalId.count({ where: { customerId: customerId! } }),
    ).toBe(0);
    const preOrder = await prisma.salesOrder.findUnique({
      where: { id: existingId },
      select: { externalCustomerCode: true },
    });
    expect(preOrder?.externalCustomerCode).toBeNull();

    // Re-import via Daily Quote Report — NOW with Cuscode column populated
    const csv = [
      csvRowWithCuscode(ORDERNO, "SBCT-RECONCILE-001", "EXISTING-1"),
      csvRowWithCuscode(ORDERNO, "SBCT-RECONCILE-001", "EXISTING-2"),
    ];
    const result = await runQuotesImport(csv);
    expect(result.errors).toEqual([]);
    expect(result.quotesUpdated).toBe(1);

    // CustomerExternalId now exists pointing at the customer
    const link = await prisma.customerExternalId.findUnique({
      where: { externalId: "SBCT-RECONCILE-001" },
    });
    expect(link).not.toBeNull();
    expect(link?.customerId).toBe(customerId);

    // SalesOrder.externalCustomerCode hydrated
    const postOrder = await prisma.salesOrder.findUnique({
      where: { id: existingId },
      select: { externalCustomerCode: true, customerId: true },
    });
    expect(postOrder?.externalCustomerCode).toBe("SBCT-RECONCILE-001");
    expect(postOrder?.customerId).toBe(customerId); // unchanged
  });

  it("existing quote with Cuscode does not clobber it when CSV row is missing Cuscode", async () => {
    // Edge case: someone manually populates externalCustomerCode on a
    // quote (or it was set via sales-runner promotion then status
    // reverted). A later quote CSV that happens to omit Cuscode for
    // that row must NOT clear the existing value.
    const existingId = await seedExistingQuote(1);
    await prisma.salesOrder.update({
      where: { id: existingId },
      data: { externalCustomerCode: "PREEXISTING-CUSCODE" },
    });

    // Re-import with NO Cuscode column in the CSV row
    const csv = [csvRow(ORDERNO, "EXISTING-1")];
    const result = await runQuotesImport(csv);
    expect(result.errors).toEqual([]);

    const postOrder = await prisma.salesOrder.findUnique({
      where: { id: existingId },
      select: { externalCustomerCode: true },
    });
    expect(postOrder?.externalCustomerCode).toBe("PREEXISTING-CUSCODE");
  });
});
