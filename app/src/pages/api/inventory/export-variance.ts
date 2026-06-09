// /app/src/pages/api/inventory/export-variance.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { AsyncParser } from "@json2csv/node";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

const APPAREL_DEPARTMENTS = ["Accessories", "Mens Apparel", "Womens Apparel"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { location, reportType, varianceType } = req.query;
  if (!location || typeof location !== "string") {
    return res.status(400).json({ error: "Location is required." });
  }

  try {
    // Get all items missing from any location
    const allMissingItems = await prisma.reconciliation.findMany({
      where: { finalVariance: { lt: 0 } },
      select: { product: { select: { externalId: true } } },
    });
    const missingExternalIds = new Set(allMissingItems.map((item) => item.product.externalId));

    const productWhereClause: Prisma.ProductWhereInput = {};
    if (reportType === "apparel") {
      productWhereClause.department = { name: { in: APPAREL_DEPARTMENTS } };
    } else if (reportType === "general") {
      if (location === "Warehouse") {
        productWhereClause.department = { name: { notIn: APPAREL_DEPARTMENTS } };
      }
    }

    const varianceWhereClause: Prisma.IntFilter = {};
    if (varianceType === "additions") {
      varianceWhereClause.gt = 0;
    } else if (varianceType === "missing") {
      varianceWhereClause.lt = 0;
    } else {
      varianceWhereClause.not = 0;
    }

    const reconciledVariances = await prisma.reconciliation.findMany({
      where: {
        location: location,
        finalVariance: varianceWhereClause,
        product: productWhereClause,
      },
      include: {
        product: {
          select: {
            externalId: true,
            productNumber: true,
            name: true,
            upcs: {
              select: { upc: true },
              take: 1,
            },
          },
        },
      },
      orderBy: {
        product: {
          name: "asc",
        },
      },
    });

    const finalReport = reconciledVariances.map((item) => ({
      barcode: item.product.upcs[0]?.upc || "N/A",
      productName: item.product.name,
      productNumber: item.product.productNumber,
      externalId: item.product.externalId,
      isPotentialTransfer:
        item.finalVariance > 0 && missingExternalIds.has(item.product.externalId),
      location: item.location,
      expected: item.initialExpected,
      counted: item.finalCount,
      variance: item.finalVariance,
      actionTaken: item.actionTaken,
    }));

    if (finalReport.length === 0) {
      res.setHeader("Content-Type", "text/plain");
      return res
        .status(200)
        .send(`No variances of type '${varianceType || "all"}' to export for this location.`);
    }

    const parser = new AsyncParser();
    const csv = await parser.parse(finalReport).promise();

    const fileName = `FINAL_${varianceType || "all"}_variances_${location}_${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.status(200).send(csv);
  } catch (error) {
    logError("Failed to generate final variance export", error);
    res.status(500).json({ error: "Failed to generate final variance export." });
  }
}
