// /app/src/pages/api/products/[id]/upcs.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Product ID is required." });
  }

  const productId = Number.parseInt(id);
  const changedBy = session.user?.email || null;

  // GET: List all UPCs for a product
  if (req.method === "GET") {
    const upcs = await prisma.upc.findMany({
      where: { productId },
      orderBy: { sortOrder: "asc" },
    });
    return res.status(200).json(
      upcs.map((u) => ({
        id: u.id,
        upc: u.upc,
        source: u.source,
        sortOrder: u.sortOrder,
      })),
    );
  }

  // POST: Add a UPC to a product
  if (req.method === "POST") {
    const { upc, source } = req.body;
    if (!upc || typeof upc !== "string" || !upc.trim()) {
      return res.status(400).json({ error: "UPC value is required." });
    }

    const validSources = ["SYSTEM", "MANUFACTURER", "IMPORT"];
    const upcSource = validSources.includes(source) ? source : "MANUFACTURER";

    try {
      // Check for duplicate
      const existing = await prisma.upc.findUnique({ where: { upc: upc.trim() } });
      if (existing) {
        return res.status(409).json({
          error: `This barcode is already assigned to product #${existing.productId}.`,
        });
      }

      const maxSort = await prisma.upc.findFirst({
        where: { productId },
        orderBy: { sortOrder: "desc" },
      });

      const created = await prisma.upc.create({
        data: {
          upc: upc.trim(),
          productId,
          source: upcSource,
          sortOrder: (maxSort?.sortOrder || 0) + 1,
          createdBy: changedBy,
        },
      });

      return res.status(201).json({
        id: created.id,
        upc: created.upc,
        source: created.source,
        sortOrder: created.sortOrder,
      });
    } catch (error) {
      logError("Error adding UPC", error);
      return res.status(500).json({ error: "Failed to add UPC." });
    }
  }

  // DELETE: Remove a UPC
  if (req.method === "DELETE") {
    const { upcId } = req.body;
    if (!upcId) return res.status(400).json({ error: "upcId is required." });

    try {
      const upc = await prisma.upc.findFirst({
        where: { id: Number.parseInt(upcId), productId },
      });
      if (!upc) return res.status(404).json({ error: "UPC not found for this product." });

      await prisma.upc.delete({ where: { id: upc.id } });
      return res.status(204).end();
    } catch (error) {
      logError("Error deleting UPC", error);
      return res.status(500).json({ error: "Failed to delete UPC." });
    }
  }

  res.setHeader("Allow", ["GET", "POST", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
