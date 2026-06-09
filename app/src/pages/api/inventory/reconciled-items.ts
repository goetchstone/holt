// /app/src/pages/api/inventory/reconciled-items.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

const APPAREL_DEPARTMENTS = ["Accessories", "Mens Apparel", "Womens Apparel"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") return res.status(405).end();

  const { location, reportType } = req.query;

  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Location is required" });
  }

  try {
    const productWhereClause: Prisma.ProductWhereInput = {};
    if (reportType === "apparel") {
      productWhereClause.department = { name: { in: APPAREL_DEPARTMENTS } };
    } else if (reportType === "general") {
      productWhereClause.department = { name: { notIn: APPAREL_DEPARTMENTS } };
    }

    const items = await prisma.reconciliation.findMany({
      where: {
        location,
        product: productWhereClause,
      },
      include: {
        product: {
          select: {
            name: true,
            productNumber: true,
            upcs: { select: { upc: true }, take: 1 }, // Fetch the first barcode
          },
        },
        reconciledBy: { select: { name: true } },
      },
      orderBy: { reconciledAt: "desc" },
    });

    // Add the barcode to the response object
    const itemsWithBarcode = items.map((item) => ({
      ...item,
      barcode: item.product.upcs[0]?.upc || "N/A",
    }));

    res.status(200).json(itemsWithBarcode);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reconciled items." });
  }
}
