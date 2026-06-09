// /app/__tests__/customerLedgerBackfill.test.ts
//
// Phase 0.5.3 — A-grade unit tests for the pure event-builder. The
// DB-touching `backfillCustomerLedger` is exercised in
// `__tests__/integration/customerLedgerBackfill.integration.test.ts` —
// see that file's header for the atomic-append + reconciliation
// contract.
//
// What this file pins:
//   1. `buildBackfillEvents` produces SALE + PAYMENT entries in the
//      right shape for the simple cases (sale, payment, refund).
//   2. CANCELLED order status suppresses the SALE event entirely.
//   3. Per-line CANCELLED filter works (matches computeBalance).
//   4. Zero-amount events are skipped (rule 12 forbids them).
//   5. VOIDED / FAILED payments are filtered (matches computeBalance).
//   6. Sorting is chronological; ties break by row id deterministically.
//   7. The full rewrite-chain shape (base + return + rewrite) produces
//      the right event sequence — same scenario as the integration
//      test but without DB I/O.

import { buildBackfillEvents } from "@/lib/customerLedgerBackfill";

// Minimal type matching `OrderRow` in the source file. We only use the
// fields buildBackfillEvents actually reads.
interface TestLineItem {
  netPrice: number;
  vatAmount: number | null;
  lineItemStatus: string;
}
interface TestPayment {
  id: number;
  paymentAmount: number;
  isRefund: boolean;
  status: string | null;
  paymentCode: string | null;
  paymentDate: Date | null;
  created: Date;
}
interface TestOrder {
  id: number;
  orderno: string;
  orderDate: Date | null;
  status: string;
  created: Date;
  lineItems: TestLineItem[];
  payments: TestPayment[];
}

function order(input: Partial<TestOrder> & { id: number; created: Date }): TestOrder {
  return {
    orderno: input.orderno ?? `SO-${input.id}`,
    orderDate: input.orderDate ?? input.created,
    status: input.status ?? "ORDER",
    lineItems: input.lineItems ?? [],
    payments: input.payments ?? [],
    ...input,
  };
}

function line(netPrice: number, vatAmount = 0, status = "ACTIVE"): TestLineItem {
  return { netPrice, vatAmount, lineItemStatus: status };
}

function payment(
  opts: Partial<TestPayment> & { id: number; paymentAmount: number; created: Date },
): TestPayment {
  return {
    isRefund: opts.isRefund ?? false,
    status: opts.status === undefined ? "COMPLETED" : opts.status,
    paymentCode: opts.paymentCode ?? null,
    paymentDate: opts.paymentDate ?? opts.created,
    ...opts,
  };
}

// ─── 1. Simple sale + payment ─────────────────────────────────────────

describe("buildBackfillEvents — simple cases", () => {
  it("produces a SALE event from non-cancelled line items", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(1000, 63.5)],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SALE");
    expect(events[0].amount).toBe(1063.5);
    expect(events[0].salesOrderId).toBe(1);
    expect(events[0].reference).toBe("SO-1");
  });

  it("produces a PAYMENT event with negative amount", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(500)],
        payments: [
          payment({ id: 100, paymentAmount: 500, created: new Date("2024-10-04T10:30:00Z") }),
        ],
      }),
    ]);
    const paymentEvent = events.find((e) => e.type === "PAYMENT");
    expect(paymentEvent).toBeDefined();
    expect(paymentEvent?.amount).toBe(-500);
    expect(paymentEvent?.paymentId).toBe(100);
  });

  it("produces a REFUND_ISSUED event with POSITIVE amount (mirrors computeBalance)", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        orderno: "SR-1",
        status: "RETURNED",
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(-500)],
        payments: [
          payment({
            id: 100,
            paymentAmount: 500,
            isRefund: true,
            created: new Date("2024-10-04T11:00:00Z"),
          }),
        ],
      }),
    ]);
    const refundEvent = events.find((e) => e.type === "REFUND_ISSUED");
    expect(refundEvent).toBeDefined();
    // Positive — refund INCREASES balance owed because it reverses
    // the prior payment. Bug fixed 2026-05-07; see signForType.
    expect(refundEvent?.amount).toBe(500);
  });
});

// ─── 2. Order/line filters ────────────────────────────────────────────

describe("buildBackfillEvents — filters", () => {
  it("skips SALE events for orders with status=CANCELLED", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        status: "CANCELLED",
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(1000)],
      }),
    ]);
    const saleEvents = events.filter((e) => e.type === "SALE");
    expect(saleEvents).toHaveLength(0);
  });

  it("excludes per-line CANCELLED items from the SALE amount", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(500, 31.75), line(9999, 635, "CANCELLED")],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(531.75);
  });

  it("skips zero-amount SALE events (no active line items)", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(100, 0, "CANCELLED")],
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("filters VOIDED payments", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(1000)],
        payments: [
          payment({
            id: 1,
            paymentAmount: 400,
            status: "COMPLETED",
            created: new Date("2024-10-04T10:10:00Z"),
          }),
          payment({
            id: 2,
            paymentAmount: 300,
            status: "VOIDED",
            created: new Date("2024-10-04T10:20:00Z"),
          }),
          payment({
            id: 3,
            paymentAmount: 200,
            status: "FAILED",
            created: new Date("2024-10-04T10:30:00Z"),
          }),
        ],
      }),
    ]);
    const paymentEvents = events.filter((e) => e.type === "PAYMENT");
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].paymentId).toBe(1);
  });

  it("INCLUDES NULL-status payments (44K legacy the POS imports)", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(500)],
        payments: [
          payment({
            id: 1,
            paymentAmount: 500,
            status: null,
            created: new Date("2024-10-04T10:30:00Z"),
          }),
        ],
      }),
    ]);
    const paymentEvents = events.filter((e) => e.type === "PAYMENT");
    expect(paymentEvents).toHaveLength(1);
  });

  it("skips zero-amount payments", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(100)],
        payments: [payment({ id: 1, paymentAmount: 0, created: new Date("2024-10-04T10:30:00Z") })],
      }),
    ]);
    const paymentEvents = events.filter((e) => e.type === "PAYMENT");
    expect(paymentEvents).toHaveLength(0);
  });
});

// ─── 3. Chronological ordering ────────────────────────────────────────

describe("buildBackfillEvents — ordering", () => {
  it("sorts events by created timestamp", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [line(100)],
      }),

      order({
        id: 2,
        created: new Date("2024-10-01T10:00:00Z"), // earlier
        lineItems: [line(200)],
      }),
    ]);
    expect(events[0].salesOrderId).toBe(2); // earlier first
    expect(events[1].salesOrderId).toBe(1);
  });

  it("breaks ties on row id deterministically", () => {
    const sameTime = new Date("2024-10-04T10:00:00Z");
    const events = buildBackfillEvents([
      order({
        id: 5,
        created: sameTime,
        lineItems: [line(100)],
      }),

      order({
        id: 3,
        created: sameTime,
        lineItems: [line(200)],
      }),
    ]);
    // Lower id first when timestamps tie.
    expect(events[0].salesOrderId).toBe(3);
    expect(events[1].salesOrderId).toBe(5);
  });
});

// ─── 4. The rewrite-chain scenario (no DB) ────────────────────────────

describe("buildBackfillEvents — rewrite chain shape", () => {
  it("produces the right event sequence for base + return + rewrite", () => {
    // Same logical scenario as the integration test, but pure-helper
    // form. Catches event-classification bugs without spinning up the
    // test DB — runs in milliseconds in the unit tier.
    const dayX = new Date("2024-10-04T10:00:00Z");
    const dayY = new Date("2024-10-05T10:00:00Z");
    const events = buildBackfillEvents([
      order({
        id: 1,
        orderno: "SO-1",
        created: dayX,
        lineItems: [line(10000, 635)],
        payments: [
          payment({ id: 1, paymentAmount: 5000, created: new Date("2024-10-04T10:30:00Z") }),
        ],
      }),

      order({
        id: 2,
        orderno: "SR-1",
        status: "RETURNED",
        created: dayY,
        lineItems: [line(-10000, -635)],
      }),

      order({
        id: 3,
        orderno: "SO-1 - A",
        created: new Date("2024-10-05T10:01:00Z"),
        lineItems: [line(11000, 698.5)],
      }),
    ]);

    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("SALE");
    expect(events[0].amount).toBe(10635);
    expect(events[0].reference).toBe("SO-1");
    expect(events[1].type).toBe("PAYMENT");
    expect(events[1].amount).toBe(-5000);
    expect(events[2].type).toBe("SALE");
    expect(events[2].amount).toBe(-10635); // SR-SAMPLE negative line items
    expect(events[2].reference).toBe("SR-1");
    expect(events[3].type).toBe("SALE");
    expect(events[3].amount).toBe(11698.5);
    expect(events[3].reference).toBe("SO-1 - A");

    // Walking the running balance manually (the production code does
    // this in backfillCustomerLedger):
    let balance = 0;
    for (const e of events) balance = Math.round((balance + e.amount) * 100) / 100;
    // Final = 10635 − 5000 − 10635 + 11698.5 = 6698.5
    // (rewrite total minus the deposit applied)
    expect(balance).toBe(6698.5);
  });
});

// ─── 5. Edge cases ────────────────────────────────────────────────────

describe("buildBackfillEvents — edge cases", () => {
  it("returns an empty array for a customer with no orders", () => {
    expect(buildBackfillEvents([])).toEqual([]);
  });

  it("handles an order with no line items and no payments (edge case)", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
      }),
    ]);
    expect(events).toEqual([]);
  });

  it("handles null vatAmount on line items", () => {
    const events = buildBackfillEvents([
      order({
        id: 1,
        created: new Date("2024-10-04T10:00:00Z"),
        lineItems: [{ netPrice: 100, vatAmount: null, lineItemStatus: "ACTIVE" }],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(100);
  });
});
