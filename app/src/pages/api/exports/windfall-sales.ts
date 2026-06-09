// /app/src/pages/api/exports/windfall-sales.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { AsyncParser } from "@json2csv/node";
import { logger, logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { start, end } = req.query;
  if (!start || !end || typeof start !== "string" || typeof end !== "string") {
    return res.status(400).json({ error: "start and end date params required (YYYY-MM-DD)" });
  }

  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T23:59:59.999Z`);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  try {
    const orders = await prisma.salesOrder.findMany({
      where: {
        orderDate: { gte: startDate, lte: endDate },
        status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
      },
      select: {
        orderno: true,
        orderDate: true,
        storeLocation: true,
        externalCustomerCode: true,
        salesperson: true,
        lineItems: {
          where: { lineItemStatus: { not: "CANCELLED" } },
          select: {
            partNo: true,
            productName: true,
            netPrice: true,
            product: {
              select: {
                vendor: { select: { name: true } },
                department: { select: { name: true } },
                category: { select: { name: true } },
                type: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { orderDate: "asc" },
    });

    const rows: Record<string, unknown>[] = [];

    for (const order of orders) {
      for (const li of order.lineItems) {
        rows.push({
          Company: order.storeLocation || "",
          Cuscode: order.externalCustomerCode || "",
          Orderdate: order.orderDate ? order.orderDate.toISOString().slice(0, 10) : "",
          Orderno: order.orderno,
          PartNo: li.partNo || "",
          ProductName: li.productName || "",
          ExtendedPrice: Number(li.netPrice),
          Department: li.product?.department?.name || "",
          Category: li.product?.category?.name || "",
          Type: li.product?.type?.name || "",
          Supplier: li.product?.vendor?.name || "",
          Salesperson: order.salesperson || "",
        });
      }
    }

    const fields = [
      "Company",
      "Cuscode",
      "Orderdate",
      "Orderno",
      "PartNo",
      "ProductName",
      "ExtendedPrice",
      "Department",
      "Category",
      "Type",
      "Supplier",
      "Salesperson",
    ];

    const parser = new AsyncParser({ fields });
    const csv = await parser.parse(rows).promise();

    const datePrefix = start.replace(/-/g, "_");
    const filename = `${datePrefix}_holt_sales.csv`;

    logger.info(`Windfall sales export: ${rows.length} line items, ${start} to ${end}`);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err: unknown) {
    logError("Windfall sales export failed", err);
    return res.status(500).json({ error: "Export failed" });
  }
}
