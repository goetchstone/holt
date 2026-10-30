// /app/__tests__/lib/purchasing/poNumber.test.ts
//
// The next PO number for a business day. The day's numbers are compared as
// numbers: as text "-1000" sorts below "-999", which would hand the thousandth
// PO of a day a number already taken, every time.

jest.mock("@/lib/appSettings", () => ({ getBusinessTimeZone: jest.fn() }));

import { nextPoNumber } from "@/lib/purchasing/poNumber";

const NOW = new Date("2026-10-30T15:00:00Z");

function dbWith(numbers: string[]) {
  return {
    purchaseOrder: {
      findMany: jest.fn(async ({ where }: { where: { poNumber: { startsWith: string } } }) =>
        numbers
          .filter((n) => n.startsWith(where.poNumber.startsWith))
          .map((poNumber) => ({ poNumber })),
      ),
    },
  } as never;
}

describe("nextPoNumber", () => {
  it("starts a business day at 001, by the business time zone", async () => {
    expect(await nextPoNumber(dbWith([]), NOW, "America/New_York")).toBe("PO-261030-001");
    // 01:00 UTC on the 31st is still the 30th in New York.
    expect(
      await nextPoNumber(dbWith([]), new Date("2026-10-31T01:00:00Z"), "America/New_York"),
    ).toBe("PO-261030-001");
  });

  it("follows the day's highest number, not another day's", async () => {
    const db = dbWith(["PO-261030-001", "PO-261030-007", "PO-261029-050"]);
    expect(await nextPoNumber(db, NOW, "UTC")).toBe("PO-261030-008");
  });

  it("counts past 999 as a number", async () => {
    const db = dbWith(["PO-261030-998", "PO-261030-999", "PO-261030-1000"]);
    expect(await nextPoNumber(db, NOW, "UTC")).toBe("PO-261030-1001");
  });

  it("ignores a number on the day's prefix that isn't one of ours", async () => {
    const db = dbWith(["PO-261030-004", "PO-261030-ABC"]);
    expect(await nextPoNumber(db, NOW, "UTC")).toBe("PO-261030-005");
  });
});
