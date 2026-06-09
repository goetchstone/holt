// /app/src/pages/api/products/[id]/variants.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const productId = Number.parseInt(req.query.id as string);

  if (Number.isNaN(productId)) {
    return res.status(400).json({ error: "Invalid product ID" });
  }

  // GET: Fetch all variants for a product
  if (req.method === "GET") {
    try {
      const variants = await prisma.productVariant.findMany({
        where: { productId },
        orderBy: { sku: "asc" }, // Or by size/color, depending on typical display order
      });
      return res.status(200).json(variants);
    } catch (error) {
      logError("Fetch variants failed", error, { productId });
      return res.status(500).json({ error: "Failed to fetch product variants" });
    }
  }

  // POST: Add new variants (supports bulk creation)
  if (req.method === "POST") {
    const variantsData = req.body; // Expects an array of variant objects

    if (!Array.isArray(variantsData) || variantsData.length === 0) {
      return res.status(400).json({ error: "No variant data provided or invalid format" });
    }

    try {
      const createdVariants = [];
      for (const variant of variantsData) {
        // Basic validation for required fields
        if (!variant.size && !variant.color && !variant.sku) {
          continue;
        }

        const newVariant = await prisma.productVariant.create({
          data: {
            productId,
            size: variant.size || null,
            color: variant.color || null,
            sku: variant.sku || null,
            upc: variant.upc || null,
            width: variant.width ? Number.parseFloat(variant.width) : null,
            length: variant.length ? Number.parseFloat(variant.length) : null,
            height: variant.height ? Number.parseFloat(variant.height) : null,
            cost: variant.cost ? Number.parseFloat(variant.cost) : null,
            wholesale: variant.wholesale ? Number.parseFloat(variant.wholesale) : null,
            retail: variant.retail ? Number.parseFloat(variant.retail) : null,
          },
        });
        createdVariants.push(newVariant);
      }
      return res.status(201).json(createdVariants);
    } catch (error: unknown) {
      logError("Create variants failed", error, { productId });
      // Check for unique constraint violation (e.g., if SKU or UPC is unique and duplicated)
      if (getErrorCode(error) === "P2002") {
        return res
          .status(409)
          .json({ error: "Duplicate variant data found (e.g., SKU or UPC already exists)" });
      }
      return res.status(500).json({
        error: "Failed to create product variants",
        details: getErrorMessage(error, "Internal server error"),
      });
    }
  }

  // PUT / PATCH: Update existing variants (supports bulk update or single update)
  // This API will expect an array of variant objects, each with an 'id'
  if (req.method === "PUT" || req.method === "PATCH") {
    const variantsData = req.body;

    if (!Array.isArray(variantsData) || variantsData.length === 0) {
      return res.status(400).json({ error: "No variant data provided or invalid format" });
    }

    try {
      const updatedVariants = [];
      for (const variant of variantsData) {
        if (!variant.id) {
          continue;
        }

        const updatedVariant = await prisma.productVariant.update({
          where: { id: variant.id },
          data: {
            size: variant.size || null,
            color: variant.color || null,
            sku: variant.sku || null,
            upc: variant.upc || null,
            width: variant.width ? Number.parseFloat(variant.width) : null,
            length: variant.length ? Number.parseFloat(variant.length) : null,
            height: variant.height ? Number.parseFloat(variant.height) : null,
            cost: variant.cost ? Number.parseFloat(variant.cost) : null,
            wholesale: variant.wholesale ? Number.parseFloat(variant.wholesale) : null,
            retail: variant.retail ? Number.parseFloat(variant.retail) : null,
          },
        });
        updatedVariants.push(updatedVariant);
      }
      return res.status(200).json(updatedVariants);
    } catch (error: unknown) {
      logError("Update variants failed", error, { productId });
      if (getErrorCode(error) === "P2002") {
        return res.status(409).json({
          error: "Duplicate variant data found during update (e.g., SKU or UPC already exists)",
        });
      }
      return res.status(500).json({
        error: "Failed to update product variants",
        details: getErrorMessage(error, "Internal server error"),
      });
    }
  }

  // DELETE: Delete a single variant (by query param id for simplicity, or in body)
  if (req.method === "DELETE") {
    const variantId = Number.parseInt(req.query.variantId as string); // Expects ?variantId=X

    if (Number.isNaN(variantId)) {
      return res.status(400).json({ error: "Invalid variant ID" });
    }

    try {
      await prisma.productVariant.delete({
        where: { id: variantId },
      });
      return res.status(204).end(); // No content for successful deletion
    } catch (error: unknown) {
      logError("Delete variant failed", error, { variantId });
      if (getErrorCode(error) === "P2003") {
        // Foreign Key Constraint Failed
        return res
          .status(409)
          .json({ error: "Cannot delete variant: It is referenced by other records." });
      }
      return res.status(500).json({
        error: "Failed to delete product variant",
        details: getErrorMessage(error, "Internal server error"),
      });
    }
  }

  res.setHeader("Allow", ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
