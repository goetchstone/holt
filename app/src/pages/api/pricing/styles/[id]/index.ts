// /app/src/pages/api/pricing/styles/[id]/index.ts
//
// GET  — Fetch a single VendorStyle with options and overrides for editing.
// PUT  — Update VendorStyle fields and upsert StyleOptionOverrides.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid style ID" });

  if (req.method === "GET") {
    return handleGet(res, id);
  }

  if (req.method === "PUT") {
    return handlePut(req, res, id);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(res: NextApiResponse, id: number) {
  const style = await prisma.vendorStyle.findUnique({
    where: { id },
    include: {
      vendor: { select: { id: true, name: true } },
      gradePrices: {
        include: { tier: { select: { id: true, code: true, name: true } } },
        orderBy: { tier: { sortOrder: "asc" } },
      },
      optionOverrides: {
        include: {
          option: {
            include: { group: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  if (!style) return res.status(404).json({ error: "Style not found" });

  // Load all vendor option groups so the editor can show options without overrides
  const vendorOptionGroups = await prisma.vendorOptionGroup.findMany({
    where: { vendorId: style.vendorId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });

  return res.json({ style, vendorOptionGroups });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse, id: number) {
  const style = await prisma.vendorStyle.findUnique({
    where: { id },
    select: { id: true, vendorId: true },
  });
  if (!style) return res.status(404).json({ error: "Style not found" });

  const { fields, optionOverrides } = req.body;

  try {
    await prisma.$transaction(async (tx) => {
      // Update VendorStyle fields (only provided values)
      if (fields && Object.keys(fields).length > 0) {
        const data: Record<string, unknown> = {};

        // Text fields
        const textFields = [
          "name",
          "description",
          "standardSeat",
          "standardBack",
          "standardPillows",
          "finish",
        ];
        for (const key of textFields) {
          if (fields[key] !== undefined) {
            data[key] = fields[key] || null;
          }
        }

        // Numeric fields (stored as Float in Prisma)
        const floatFields = ["width", "depth", "height", "seatHeight", "armHeight", "seatDepth"];
        for (const key of floatFields) {
          if (fields[key] !== undefined) {
            data[key] =
              fields[key] !== null && fields[key] !== "" ? Number.parseFloat(fields[key]) : null;
          }
        }

        // Decimal fields (stored as Decimal in Prisma)
        const decimalFields = [
          "baseCost",
          "baseRetail",
          "mapPrice",
          "comYardage",
          "comYardagePattern",
          "comYardageRepeat",
          "gradeRiser",
        ];
        for (const key of decimalFields) {
          if (fields[key] !== undefined) {
            data[key] = fields[key] !== null && fields[key] !== "" ? fields[key] : null;
          }
        }

        if (Object.keys(data).length > 0) {
          await tx.vendorStyle.update({ where: { id }, data });

          // Mirror to Product record if one exists for this style
          const productData: Record<string, unknown> = {};
          if (data.name !== undefined) productData.name = data.name;
          if (data.description !== undefined) productData.description = data.description;
          if (data.baseCost !== undefined) productData.baseCost = data.baseCost;
          if (data.baseRetail !== undefined) productData.baseRetail = data.baseRetail;
          if (data.mapPrice !== undefined) productData.mapPrice = data.mapPrice;

          if (Object.keys(productData).length > 0) {
            await tx.product.updateMany({
              where: { vendorStyleId: id },
              data: productData,
            });
          }
        }
      }

      // Upsert StyleOptionOverrides
      if (optionOverrides && Array.isArray(optionOverrides)) {
        for (const override of optionOverrides) {
          const { optionId, surcharge, isAvailable, isStandard, notes } = override;
          if (!optionId) continue;

          await tx.styleOptionOverride.upsert({
            where: {
              vendorStyleId_optionId: {
                vendorStyleId: id,
                optionId,
              },
            },
            create: {
              vendorStyleId: id,
              optionId,
              surcharge: surcharge != null ? surcharge : null,
              isAvailable: isAvailable ?? true,
              isStandard: isStandard ?? false,
              notes: notes || null,
            },
            update: {
              surcharge: surcharge != null ? surcharge : null,
              isAvailable: isAvailable ?? true,
              isStandard: isStandard ?? false,
              notes: notes || null,
            },
          });
        }
      }
    });

    // Return the updated style
    const updated = await prisma.vendorStyle.findUnique({
      where: { id },
      include: {
        vendor: { select: { id: true, name: true } },
        optionOverrides: {
          include: {
            option: {
              include: { group: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });

    return res.json(updated);
  } catch (error: unknown) {
    logError("Style update error", error);
    return res.status(500).json({
      error: "Failed to update style",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}
