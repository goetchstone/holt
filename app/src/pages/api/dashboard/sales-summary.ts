// /app/src/pages/api/dashboard/sales-summary.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface StoreSalesData {
  items: number;
  netSales: number;
  tax: number;
  total: number;
}

interface StoreSummary {
  location: string;
  items: number;
  netSales: number;
  tax: number;
  total: number;
  lyItems: number;
  lyNetSales: number;
  lyTax: number;
  lyTotal: number;
}

// Aggregates order line item data by store for a date range
async function sumSalesByStore(from: Date, to: Date): Promise<Record<string, StoreSalesData>> {
  const orders = await prisma.salesOrder.findMany({
    where: {
      orderDate: { gte: from, lt: to },
      status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
    },
    select: {
      storeLocation: true,
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: { netPrice: true, vatAmount: true },
      },
    },
  });

  const result: Record<string, StoreSalesData> = {};
  for (const order of orders) {
    if (order.lineItems.length === 0) continue;
    const store = order.storeLocation || "Unknown";

    if (!result[store]) {
      result[store] = { items: 0, netSales: 0, tax: 0, total: 0 };
    }
    const entry = result[store];
    for (const li of order.lineItems) {
      const net = Number(li.netPrice || 0);
      const vat = Number(li.vatAmount || 0);
      if (net > 0) entry.items += 1;
      entry.netSales += net;
      entry.tax += vat;
      entry.total += net + vat;
    }
  }
  return result;
}

export default requireAuth(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Date boundaries in UTC (the POS dates are midnight UTC)
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const todayStart = new Date(Date.UTC(y, m, d));
    const todayEnd = new Date(Date.UTC(y, m, d + 1));
    const lyStart = new Date(Date.UTC(y - 1, m, d));
    const lyEnd = new Date(Date.UTC(y - 1, m, d + 1));

    const [todaySales, lySales] = await Promise.all([
      sumSalesByStore(todayStart, todayEnd),
      sumSalesByStore(lyStart, lyEnd),
    ]);

    // Merge all store names, excluding "Unknown"
    const storeNames = new Set<string>([...Object.keys(todaySales), ...Object.keys(lySales)]);
    storeNames.delete("Unknown");

    const stores: StoreSummary[] = Array.from(storeNames)
      .sort((a, b) => a.localeCompare(b))
      .map((location) => {
        const ts = todaySales[location];
        const ls = lySales[location];
        return {
          location,
          items: ts?.items ?? 0,
          netSales: Math.round((ts?.netSales ?? 0) * 100) / 100,
          tax: Math.round((ts?.tax ?? 0) * 100) / 100,
          total: Math.round((ts?.total ?? 0) * 100) / 100,
          lyItems: ls?.items ?? 0,
          lyNetSales: Math.round((ls?.netSales ?? 0) * 100) / 100,
          lyTax: Math.round((ls?.tax ?? 0) * 100) / 100,
          lyTotal: Math.round((ls?.total ?? 0) * 100) / 100,
        };
      });

    return res.status(200).json({ stores });
  } catch (error) {
    logError("Sales summary API error", error);
    return res.status(500).json({ error: "Failed to load sales summary" });
  }
});
