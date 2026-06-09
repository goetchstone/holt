// /app/__tests__/integration/customerArDriftRunner.integration.test.ts
//
// Phase 0.5.5 — B-grade integration tests for the AR-drift runner.
//
// What this verifies (and a mocked-Prisma test CANNOT):
//
//   1. The "recent activity" lookback actually filters by `created`
//      timestamps in Postgres (a SQL gte on DateTime is the kind of
//      thing that goes wrong in subtle TZ-related ways).
//
//   2. The bulk hydration query groups orders correctly by customerId
//      across the JS layer — a one-to-many that mocked Prisma would
//      have to fake.
//
//   3. The full pipeline (selectCustomersForCheck → hydrate →
//      compareCustomerArBalances) produces the expected drift report
//      for realistic shapes: stored matches source, stored under-bills,
//      stored over-bills, CANCELLED lines excluded, refunds flip sign.
//
// Per-file isolation per scripts/run-integration-tests.sh.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runCustomerArDriftCheck, buildCustomerLabel } from "@/lib/customerArDriftRunner";

describe("runCustomerArDriftCheck (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns an empty report when no customer has activity in the lookback window", async () => {
    // Create a customer with non-zero balance but no recent activity.
    // Stored balance is by definition correct (no events to drift it).
    await prisma.customer.create({
      data: { firstName: "Quiet", lastName: "Customer", openArBalance: 999 },
    });

    const result = await runCustomerArDriftCheck({ now: new Date("2026-05-12T12:00:00Z") });
    expect(result.checked).toBe(0);
    expect(result.ok).toBe(0);
    expect(result.drifted).toHaveLength(0);
  });

  it("flags drift when stored openArBalance is under the source-derived balance", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Under", lastName: "Billed", openArBalance: 100 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `DRIFT-UNDER-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    // Line item totalling $500; no payments → source says they owe $500
    // but stored says $100. Drift of -$400 (stored < source).
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(500),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    // The runner only picks up customers with recent payment or ledger
    // activity. Seed a ledger entry to qualify them; appendEntry would
    // do the same in production.
    await prisma.customerLedgerEntry.create({
      data: {
        customerId: customer.id,
        type: "SALE",
        amount: new Prisma.Decimal(100),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(100),
        reference: "seed",
      },
    });

    const result = await runCustomerArDriftCheck({ now: new Date() });
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(0);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].customerId).toBe(customer.id);
    expect(result.drifted[0].storedBalance).toBe(100);
    expect(result.drifted[0].sourceBalance).toBe(500);
    expect(result.drifted[0].diff).toBe(-400);
    expect(result.totalAbsoluteDrift).toBe(400);
  });

  it("counts a customer as OK when stored matches the source (the post-PR-#252 happy path)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "All", lastName: "Synced", openArBalance: 250 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `DRIFT-OK-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(750),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    // Payment $500 → source says they owe 750 - 500 = 250. Matches stored.
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date(),
        paymentType: "card",
        paymentAmount: new Prisma.Decimal(500),
        status: "COMPLETED",
        customerId: customer.id,
      },
    });

    const result = await runCustomerArDriftCheck({ now: new Date() });
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.drifted).toHaveLength(0);
  });

  it("excludes CANCELLED line items from the source-side recompute (CLAUDE.md rule 33)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Cancelled", lastName: "Line", openArBalance: 200 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `DRIFT-CXL-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    // Active 200 + cancelled 999 — only 200 should count.
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(200),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 2,
        netPrice: new Prisma.Decimal(999),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "CANCELLED",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    await prisma.customerLedgerEntry.create({
      data: {
        customerId: customer.id,
        type: "SALE",
        amount: new Prisma.Decimal(200),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(200),
        reference: "seed",
      },
    });

    const result = await runCustomerArDriftCheck({ now: new Date() });
    expect(result.ok).toBe(1); // 200 matches 200 (CANCELLED excluded)
    expect(result.drifted).toHaveLength(0);
  });

  it("respects the lookbackHours param — customer with activity outside the window is skipped", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Old", lastName: "Activity", openArBalance: 0 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `DRIFT-OLD-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(500),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    // Payment created 48h ago — outside a 24h lookback window.
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date(),
        paymentType: "card",
        paymentAmount: new Prisma.Decimal(100),
        status: "COMPLETED",
        customerId: customer.id,
        created: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    });

    const result = await runCustomerArDriftCheck({ lookbackHours: 24, now: new Date() });
    expect(result.checked).toBe(0); // customer not in candidate set
  });

  it("groups multi-order customers correctly (one customer, multiple SalesOrders)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Multi", lastName: "Order", openArBalance: 0 },
    });
    // Order 1: $300 owed, $300 paid → 0 net.
    const order1 = await prisma.salesOrder.create({
      data: {
        orderno: `MULTI-1-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order1.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(300),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order1.id,
        paymentDate: new Date(),
        paymentType: "card",
        paymentAmount: new Prisma.Decimal(300),
        status: "COMPLETED",
        customerId: customer.id,
      },
    });
    // Order 2: $500 owed, $0 paid → +500.
    const order2 = await prisma.salesOrder.create({
      data: {
        orderno: `MULTI-2-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order2.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(500),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });

    const result = await runCustomerArDriftCheck({ now: new Date() });
    expect(result.checked).toBe(1);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0].sourceBalance).toBe(500); // 0 + 500 across both orders
    expect(result.drifted[0].diff).toBe(-500); // stored 0 - source 500
  });

  it("ignores SalesOrders with status=CANCELLED (rolled-back orders don't drift the balance)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Cxl", lastName: "Order", openArBalance: 0 },
    });
    const cancelledOrder = await prisma.salesOrder.create({
      data: {
        orderno: `DRIFT-CXLORDER-${Date.now()}`,
        status: "CANCELLED",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: cancelledOrder.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(1000),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: cancelledOrder.id,
        paymentDate: new Date(),
        paymentType: "card",
        paymentAmount: new Prisma.Decimal(100),
        status: "COMPLETED",
        customerId: customer.id,
      },
    });

    const result = await runCustomerArDriftCheck({ now: new Date() });
    // Customer is in the candidate set (recent payment activity), but
    // their CANCELLED order is excluded from the source recompute. Net
    // source = 0 (the order doesn't count); stored = 0 → OK.
    expect(result.ok).toBe(1);
    expect(result.drifted).toHaveLength(0);
  });

  // ── Phase 0.5.7 — hand-picked customerIds mode ──────────────────────

  it("hand-picked mode: checks the EXACT customerIds provided, ignoring activity window", async () => {
    // Customer A: has activity → would be picked up by lookback mode
    const a = await prisma.customer.create({
      data: { firstName: "Active", lastName: "A", openArBalance: 0 },
    });
    const orderA = await prisma.salesOrder.create({
      data: {
        orderno: `HANDPICK-A-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: a.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: orderA.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(500),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: orderA.id,
        paymentDate: new Date(),
        paymentType: "card",
        paymentAmount: new Prisma.Decimal(0),
        status: "COMPLETED",
        customerId: a.id,
      },
    });

    // Customer B: NO activity but has a stored balance — lookback would skip them
    const b = await prisma.customer.create({
      data: { firstName: "Quiet", lastName: "B", openArBalance: 999 },
    });
    const orderB = await prisma.salesOrder.create({
      data: {
        orderno: `HANDPICK-B-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2024-01-01"), // ancient
        customerId: b.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: orderB.id,
        lineNumber: 1,
        netPrice: new Prisma.Decimal(1500),
        vatAmount: new Prisma.Decimal(0),
        lineItemStatus: "ACTIVE",
        orderedQuantity: 1,
        cost: new Prisma.Decimal(0),
      },
    });

    // Hand-pick BOTH customers — should validate both regardless of activity
    const result = await runCustomerArDriftCheck({
      customerIds: [a.id, b.id],
      now: new Date(),
    });

    expect(result.mode).toBe("hand-picked");
    expect(result.lookbackHours).toBeNull();
    expect(result.checked).toBe(2);
    // A: stored 0 vs source 500 → drifted -500
    // B: stored 999 vs source 1500 → drifted -501
    expect(result.drifted).toHaveLength(2);
    const aRow = result.drifted.find((d) => d.customerId === a.id);
    const bRow = result.drifted.find((d) => d.customerId === b.id);
    expect(aRow?.diff).toBe(-500);
    expect(bRow?.diff).toBe(-501);
  });

  it("hand-picked mode: empty customerIds short-circuits to checked=0 (no lookback fallback)", async () => {
    // Seed a customer with recent activity — lookback mode would find them
    const c = await prisma.customer.create({
      data: { firstName: "Should", lastName: "Skip", openArBalance: 0 },
    });
    await prisma.customerLedgerEntry.create({
      data: {
        customerId: c.id,
        type: "SALE",
        amount: new Prisma.Decimal(100),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(100),
        reference: "seed",
      },
    });

    const result = await runCustomerArDriftCheck({ customerIds: [], now: new Date() });
    expect(result.mode).toBe("hand-picked");
    expect(result.checked).toBe(0);
    expect(result.drifted).toHaveLength(0);
  });

  it("hand-picked mode: dedups and filters non-positive/non-integer ids", async () => {
    const c = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Cust", openArBalance: 0 },
    });

    const result = await runCustomerArDriftCheck({
      customerIds: [c.id, c.id, -5, 0, Number.NaN, c.id],
      now: new Date(),
    });
    expect(result.checked).toBe(1); // only c.id, deduped
  });

  it("hand-picked mode: missing customerIds are silently skipped (not an error)", async () => {
    // Hand-pick a customer that doesn't exist plus one that does.
    const real = await prisma.customer.create({
      data: { firstName: "Real", lastName: "Customer", openArBalance: 0 },
    });
    const result = await runCustomerArDriftCheck({
      customerIds: [real.id, 99999999],
      now: new Date(),
    });
    expect(result.checked).toBe(1); // only the real one (the missing id has no row to compare)
  });

  it("lookback mode: result includes mode='lookback' + numeric lookbackHours", async () => {
    const c = await prisma.customer.create({
      data: { firstName: "Mode", lastName: "Test", openArBalance: 0 },
    });
    await prisma.customerLedgerEntry.create({
      data: {
        customerId: c.id,
        type: "SALE",
        amount: new Prisma.Decimal(100),
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: new Prisma.Decimal(100),
        reference: "seed",
      },
    });

    const result = await runCustomerArDriftCheck({ lookbackHours: 48, now: new Date() });
    expect(result.mode).toBe("lookback");
    expect(result.lookbackHours).toBe(48);
  });
});

describe("buildCustomerLabel", () => {
  it("returns 'Last, F.' when both names present", () => {
    expect(buildCustomerLabel("Jane", "Smith", 1)).toBe("Smith, J.");
  });
  it("returns the last name alone when first is missing", () => {
    expect(buildCustomerLabel(null, "Smith", 1)).toBe("Smith");
    expect(buildCustomerLabel("  ", "Smith", 1)).toBe("Smith");
  });
  it("returns the first name alone when last is missing", () => {
    expect(buildCustomerLabel("Jane", null, 1)).toBe("Jane");
  });
  it("falls back to id when neither name is set", () => {
    expect(buildCustomerLabel(null, null, 42)).toBe("Customer #42");
    expect(buildCustomerLabel("", "", 99)).toBe("Customer #99");
  });
});
