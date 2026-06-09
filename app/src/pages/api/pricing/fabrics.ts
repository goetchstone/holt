// /app/src/pages/api/pricing/fabrics.ts
//
// GET  /api/pricing/fabrics?vendorId=X         — list fabrics for a vendor
// GET  /api/pricing/fabrics?vendorId=X&tierId=Y — filter by grade tier
// GET  /api/pricing/fabrics?vendorId=X&search=Z — search by name/code/color
// POST /api/pricing/fabrics                    — create a single fabric entry

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ─── GET: List/search fabrics ──────────────────────────────────
  if (req.method === "GET") {
    const vendorId = Number.parseInt(req.query.vendorId as string);
    if (Number.isNaN(vendorId)) {
      return res.status(400).json({ error: "vendorId is required" });
    }

    const tierId = req.query.tierId ? Number.parseInt(req.query.tierId as string) : null;
    const search = (req.query.search as string)?.trim() || "";
    const activeOnly = req.query.all !== "true";
    const limit = Math.min(Number.parseInt(req.query.limit as string) || 500, 5000);
    const offset = Number.parseInt(req.query.offset as string) || 0;

    const where: any = { vendorId };

    if (activeOnly) {
      where.isActive = true;
      where.isDiscontinued = false;
    }

    if (tierId) {
      where.tierId = tierId;
    }

    if (search) {
      where.OR = [
        { fabricName: { contains: search, mode: "insensitive" } },
        { fabricCode: { contains: search, mode: "insensitive" } },
        { colorName: { contains: search, mode: "insensitive" } },
        { colorCode: { contains: search, mode: "insensitive" } },
        { collection: { contains: search, mode: "insensitive" } },
      ];
    }

    try {
      const [fabrics, total] = await Promise.all([
        prisma.fabricCatalog.findMany({
          where,
          include: {
            tier: {
              select: { id: true, code: true, name: true, sortOrder: true },
            },
          },
          orderBy: [{ fabricName: "asc" }, { colorName: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.fabricCatalog.count({ where }),
      ]);

      // Also return summary stats
      const gradeBreakdown = await prisma.fabricCatalog.groupBy({
        by: ["tierId"],
        where: { vendorId, isActive: true },
        _count: true,
      });

      return res.json({
        fabrics,
        total,
        limit,
        offset,
        gradeBreakdown,
      });
    } catch (error: unknown) {
      logError("Fabric list error", error);
      return res.status(500).json({
        error: "Failed to fetch fabrics",
        details: getErrorMessage(error, "Internal server error"),
      });
    }
  }

  // ─── POST: Create single fabric ───────────────────────────────
  if (req.method === "POST") {
    const {
      vendorId,
      tierId,
      fabricName,
      fabricCode,
      colorName,
      colorCode,
      patternRepeat,
      width,
      content,
      collection,
      usage,
      notes,
    } = req.body;

    if (!vendorId || !tierId || !fabricName) {
      return res.status(400).json({ error: "vendorId, tierId, and fabricName are required" });
    }

    try {
      const fabric = await prisma.fabricCatalog.create({
        data: {
          vendorId,
          tierId,
          fabricName,
          fabricCode: fabricCode || null,
          colorName: colorName || "",
          colorCode: colorCode || null,
          patternRepeat: patternRepeat || null,
          width: width || null,
          content: content || null,
          collection: collection || null,
          usage: usage || null,
          notes: notes || null,
        },
        include: {
          tier: { select: { id: true, code: true, name: true } },
        },
      });
      return res.status(201).json(fabric);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({
          error: "Fabric already exists with this name and color for this vendor",
        });
      }
      logError("Fabric create error", err);
      return res.status(500).json({
        error: "Failed to create fabric",
        details: getErrorMessage(err, "Internal server error"),
      });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
