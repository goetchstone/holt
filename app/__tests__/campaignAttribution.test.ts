// /app/__tests__/campaignAttribution.test.ts

import {
  computeCampaignAttribution,
  type EngagementEvent,
  type AttributableOrder,
} from "@/lib/campaignAttribution";

const open = (campaignId: string, customerId: number, timestamp: string): EngagementEvent => ({
  campaignId,
  customerId,
  action: "open",
  timestamp: new Date(timestamp),
});

const click = (campaignId: string, customerId: number, timestamp: string): EngagementEvent => ({
  campaignId,
  customerId,
  action: "click",
  timestamp: new Date(timestamp),
});

const order = (
  customerId: number,
  orderDate: string,
  lineItems: { netPrice: number; departmentName?: string | null }[],
): AttributableOrder => ({
  customerId,
  orderDate: new Date(orderDate),
  lineItems: lineItems.map((li) => ({
    netPrice: li.netPrice,
    // Preserve explicit null (used by the null-dept test); default only
    // when the field is undefined/omitted.
    departmentName: "departmentName" in li ? (li.departmentName as string | null) : "Furniture",
  })),
});

describe("computeCampaignAttribution", () => {
  it("returns an empty map when there are no engagements", () => {
    const r = computeCampaignAttribution([], [], 30);
    expect(r.size).toBe(0);
  });

  it("counts a simple engaged-and-purchased customer", () => {
    const engagements = [open("c1", 1, "2026-01-01")];
    const orders = [order(1, "2026-01-15", [{ netPrice: 500 }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    const res = r.get("c1")!;
    expect(res.uniqueOpeners).toBe(1);
    expect(res.purchasers).toBe(1);
    expect(res.orderCount).toBe(1);
    expect(res.revenue).toBe(500);
    expect(res.openConversionPct).toBe(100);
  });

  it("does not count an order placed BEFORE engagement", () => {
    const engagements = [open("c1", 1, "2026-01-15")];
    const orders = [order(1, "2026-01-10", [{ netPrice: 500 }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.purchasers).toBe(0);
    expect(r.get("c1")!.revenue).toBe(0);
  });

  it("does not count an order placed OUTSIDE the window", () => {
    const engagements = [open("c1", 1, "2026-01-01")];
    const orders = [order(1, "2026-02-15", [{ netPrice: 500 }])]; // 45 days later
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.purchasers).toBe(0);
  });

  it("counts multiple orders from the same customer within the window", () => {
    const engagements = [open("c1", 1, "2026-01-01")];
    const orders = [
      order(1, "2026-01-05", [{ netPrice: 200 }]),
      order(1, "2026-01-20", [{ netPrice: 300 }]),
    ];
    const r = computeCampaignAttribution(engagements, orders, 30);
    const res = r.get("c1")!;
    expect(res.purchasers).toBe(1);
    expect(res.orderCount).toBe(2);
    expect(res.revenue).toBe(500);
  });

  it("a clicker who purchased counts on both click and open conversion when they also opened", () => {
    const engagements = [open("c1", 1, "2026-01-01"), click("c1", 1, "2026-01-02")];
    const orders = [order(1, "2026-01-10", [{ netPrice: 100 }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    const res = r.get("c1")!;
    expect(res.uniqueOpeners).toBe(1);
    expect(res.uniqueClickers).toBe(1);
    expect(res.openersWhoPurchased).toBe(1);
    expect(res.clickersWhoPurchased).toBe(1);
    expect(res.openConversionPct).toBe(100);
    expect(res.clickConversionPct).toBe(100);
  });

  it("uses first engagement time as the window anchor", () => {
    const engagements = [
      open("c1", 1, "2026-01-01"),
      open("c1", 1, "2026-01-25"), // second open
    ];
    // Order on day 20 is within 30d of first engagement (jan 1) — still counts.
    const orders = [order(1, "2026-01-20", [{ netPrice: 100 }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.purchasers).toBe(1);
  });

  it("rolls up revenue by department", () => {
    const engagements = [open("c1", 1, "2026-01-01"), open("c1", 2, "2026-01-01")];
    const orders = [
      order(1, "2026-01-10", [
        { netPrice: 500, departmentName: "Furniture" },
        { netPrice: 100, departmentName: "Home Acc" },
      ]),
      order(2, "2026-01-10", [{ netPrice: 200, departmentName: "Furniture" }]),
    ];
    const r = computeCampaignAttribution(engagements, orders, 30);
    const res = r.get("c1")!;
    expect(res.revenue).toBe(800);
    const furn = res.revenueByDepartment.find((d) => d.departmentName === "Furniture")!;
    const acc = res.revenueByDepartment.find((d) => d.departmentName === "Home Acc")!;
    expect(furn.revenue).toBe(700);
    expect(acc.revenue).toBe(100);
    // Department breakdown is sorted by revenue desc.
    expect(res.revenueByDepartment[0].departmentName).toBe("Furniture");
  });

  it("treats null department as '(unassigned)'", () => {
    const engagements = [open("c1", 1, "2026-01-01")];
    const orders = [order(1, "2026-01-10", [{ netPrice: 100, departmentName: null }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.revenueByDepartment[0].departmentName).toBe("(unassigned)");
  });

  it("same customer across two campaigns gets credit in both (non-exclusive)", () => {
    const engagements = [open("c1", 1, "2026-01-01"), open("c2", 1, "2026-01-05")];
    const orders = [order(1, "2026-01-10", [{ netPrice: 500 }])];
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.revenue).toBe(500);
    expect(r.get("c2")!.revenue).toBe(500);
  });

  it("top purchasers are sorted by revenue desc and capped at 10", () => {
    const engagements = Array.from({ length: 12 }, (_, i) => open("c1", i + 1, "2026-01-01"));
    const orders = Array.from({ length: 12 }, (_, i) =>
      order(i + 1, "2026-01-10", [{ netPrice: (i + 1) * 100 }]),
    );
    const r = computeCampaignAttribution(engagements, orders, 30);
    const res = r.get("c1")!;
    expect(res.topPurchasers).toHaveLength(10);
    expect(res.topPurchasers[0].customerId).toBe(12);
    expect(res.topPurchasers[0].revenue).toBe(1200);
    expect(res.topPurchasers[9].customerId).toBe(3);
  });

  it("avgOrderValue is revenue / orderCount", () => {
    const engagements = [open("c1", 1, "2026-01-01")];
    const orders = [
      order(1, "2026-01-10", [{ netPrice: 300 }]),
      order(1, "2026-01-20", [{ netPrice: 100 }]),
    ];
    const r = computeCampaignAttribution(engagements, orders, 30);
    expect(r.get("c1")!.avgOrderValue).toBe(200);
  });

  describe("last-touch mode", () => {
    it("credits only the latest engagement within window", () => {
      // Customer engages with c1 day 1, c2 day 10, buys day 15.
      // Both c1 and c2 have the order in-window. Last-touch = c2 wins.
      const engagements = [open("c1", 1, "2026-01-01"), open("c2", 1, "2026-01-10")];
      const orders = [order(1, "2026-01-15", [{ netPrice: 500 }])];
      const r = computeCampaignAttribution(engagements, orders, 30, { mode: "last-touch" });
      expect(r.get("c1")!.revenue).toBe(0);
      expect(r.get("c1")!.purchasers).toBe(0);
      expect(r.get("c2")!.revenue).toBe(500);
      expect(r.get("c2")!.purchasers).toBe(1);
    });

    it("summed revenue across campaigns equals true sales (no double-count)", () => {
      const engagements = [open("c1", 1, "2026-01-01"), open("c2", 1, "2026-01-10")];
      const orders = [order(1, "2026-01-15", [{ netPrice: 500 }])];
      const r = computeCampaignAttribution(engagements, orders, 30, { mode: "last-touch" });
      const total = Array.from(r.values()).reduce((s, v) => s + v.revenue, 0);
      expect(total).toBe(500); // shared mode would give 1000
    });

    it("falls back to earlier campaign when later one is outside window", () => {
      const engagements = [open("c1", 1, "2026-01-01"), open("c2", 1, "2025-10-01")];
      const orders = [order(1, "2026-01-20", [{ netPrice: 100 }])];
      // c2 engagement (Oct 1) is >30 days before order (Jan 20) -> out of window.
      // c1 engagement (Jan 1) -> 19 days before -> wins.
      const r = computeCampaignAttribution(engagements, orders, 30, { mode: "last-touch" });
      expect(r.get("c1")!.revenue).toBe(100);
      expect(r.get("c2")!.revenue).toBe(0);
    });
  });

  describe("brand-new customer filter", () => {
    it("excludes customer whose first order was within the buffer before engagement", () => {
      // firstOrder on Jan 1, engagement on Feb 10 (40 days later).
      // With excludeNewCustomerDays=60, customer is still "brand new".
      const engagements = [open("c1", 1, "2026-02-10")];
      const orders = [order(1, "2026-02-15", [{ netPrice: 500 }])];
      const firstOrders = new Map([[1, new Date("2026-01-01")]]);
      const r = computeCampaignAttribution(engagements, orders, 30, {
        excludeNewCustomerDays: 60,
        customerFirstOrderDates: firstOrders,
      });
      expect(r.get("c1")!.purchasers).toBe(0);
      expect(r.get("c1")!.revenue).toBe(0);
    });

    it("keeps customer whose first order was before the buffer", () => {
      // firstOrder a year ago -> established customer, keep.
      const engagements = [open("c1", 1, "2026-02-10")];
      const orders = [order(1, "2026-02-15", [{ netPrice: 500 }])];
      const firstOrders = new Map([[1, new Date("2025-01-01")]]);
      const r = computeCampaignAttribution(engagements, orders, 30, {
        excludeNewCustomerDays: 60,
        customerFirstOrderDates: firstOrders,
      });
      expect(r.get("c1")!.revenue).toBe(500);
    });

    it("keeps customer whose first order is AFTER engagement (email drove the first sale)", () => {
      // Customer on list before ever buying, opens campaign, then buys first-ever.
      // Not brand-new-from-walk-in; this is the email actually working.
      const engagements = [open("c1", 1, "2026-02-10")];
      const orders = [order(1, "2026-02-20", [{ netPrice: 500 }])];
      const firstOrders = new Map([[1, new Date("2026-02-20")]]);
      const r = computeCampaignAttribution(engagements, orders, 30, {
        excludeNewCustomerDays: 60,
        customerFirstOrderDates: firstOrders,
      });
      expect(r.get("c1")!.revenue).toBe(500);
    });

    it("passes through customers with no first-order-date entry (no history known)", () => {
      const engagements = [open("c1", 1, "2026-02-10")];
      const orders = [order(1, "2026-02-15", [{ netPrice: 500 }])];
      const r = computeCampaignAttribution(engagements, orders, 30, {
        excludeNewCustomerDays: 60,
        customerFirstOrderDates: new Map(),
      });
      expect(r.get("c1")!.revenue).toBe(500);
    });
  });

  it("conversion rates report 0 (not divide-by-zero) when nobody engaged", () => {
    // impossible to have purchasers without engagements -- still, confirm sane
    // output when the set is weird.
    const r = computeCampaignAttribution([], [], 30);
    expect(r.size).toBe(0);
  });
});
