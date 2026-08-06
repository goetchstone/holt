// /app/__tests__/integration/errorRecorder.integration.test.ts
//
// The two properties that decide whether error tracking helps or hurts during
// a real incident, tested against a real database because both are about what
// actually lands in rows:
//
//   1. GROUPING. A crash loop must be ONE row with a high count. If it wrote
//      one row per occurrence it would fill the disk during exactly the
//      incident the table exists to explain, and bury every other error.
//
//   2. ALERT RATE-LIMITING. The same loop must send a handful of alerts, not
//      5,000. An alert channel that floods gets muted, which is worse than
//      never having alerted.
//
// opsAlert is mocked so alerting can be counted without sending anything.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

const alerts: Array<{ title: string }> = [];

jest.mock("@/lib/opsAlert", () => ({
  reportOpsAlert: jest.fn(async (a: { title: string }) => {
    alerts.push(a);
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordError } = require("@/lib/errorRecorder") as typeof import("@/lib/errorRecorder");

/** recordError is fire-and-forget by design; give its detached promise a turn. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("error recorder (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    alerts.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("groups the same failure on different records into ONE row", async () => {
    // The canonical case: a loop over orders, each failing the same way.
    for (const id of [1, 2, 3, 4, 5]) {
      recordError({ message: "Failed to post journal", error: new Error(`Order ${id} not found`) });
      await settle();
    }

    const rows = await prisma.errorEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
  });

  it("keeps genuinely different failures in different rows", async () => {
    recordError({ message: "A failed", error: new Error("Order 1 not found") });
    await settle();
    recordError({ message: "B failed", error: new Error("Customer 1 not found") });
    await settle();

    expect(await prisma.errorEvent.count()).toBe(2);
  });

  it("alerts on the FIRST occurrence and then rate-limits", async () => {
    for (let i = 0; i < 12; i++) {
      recordError({ message: "Boom", error: new Error(`attempt ${i}`) });
      await settle();
    }

    const row = await prisma.errorEvent.findFirstOrThrow();
    expect(row.count).toBe(12);
    // Thresholds are 1 and 10 within this range -- not 12 alerts.
    expect(alerts).toHaveLength(2);
    expect(alerts[0].title).toMatch(/^New error:/);
    expect(alerts[1].title).toMatch(/12x|10x/);
  });

  it("records the raw message but fingerprints the normalised one", async () => {
    // An operator needs the real id to investigate; the fingerprint must not.
    recordError({ message: "Failed", error: new Error("Order 4815162342 not found") });
    await settle();

    const row = await prisma.errorEvent.findFirstOrThrow();
    expect(row.message).toContain("4815162342");
    expect(row.normalized).not.toContain("4815162342");
  });

  it("un-resolves an error that comes back", async () => {
    // Resolving is a statement about what you have seen, not a permanent mute.
    recordError({ message: "Flaky", error: new Error("boom") });
    await settle();
    await prisma.errorEvent.updateMany({
      data: { resolvedAt: new Date(), resolvedBy: "admin@example.com" },
    });

    recordError({ message: "Flaky", error: new Error("boom") });
    await settle();

    const row = await prisma.errorEvent.findFirstOrThrow();
    expect(row.resolvedAt).toBeNull();
    expect(row.count).toBe(2);
  });

  it("keeps the most recent context as the sample", async () => {
    recordError({ message: "X", error: new Error("boom"), context: { orderId: 1 } });
    await settle();
    recordError({ message: "X", error: new Error("boom"), context: { orderId: 2 } });
    await settle();

    const row = await prisma.errorEvent.findFirstOrThrow();
    expect((row.sample as { orderId: number }).orderId).toBe(2);
  });
});
