// /app/src/pages/api/diagnostics/upcs.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const page = Number(req.query.page) || 1;
  const pageSize = 100;

  try {
    const rawUpcs = await prisma.upc.findMany({
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { product: { name: "asc" } },
      include: {
        product: {
          select: { name: true, productNumber: true },
        },
      },
    });

    const totalCount = await prisma.upc.count();

    // CORRECTED: Flatten the data structure before sending it to the frontend.
    // This creates simple, top-level properties that the table component can understand.
    const flattenedUpcs = rawUpcs.map((item) => ({
      id: item.id,
      upc: item.upc,
      productName: item.product?.name || "N/A",
      productNumber: item.product?.productNumber || "N/A",
    }));

    res.status(200).json({ upcs: flattenedUpcs, totalCount });
  } catch (error) {
    logError("Failed to fetch UPCs", error);
    res.status(500).json({ error: "Failed to fetch UPC data." });
  }
}

export default requirePermission("catalog.write", handler);
