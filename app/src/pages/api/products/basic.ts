// /app/src/pages/api/products/basic.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    const {
      name,
      productNumber,
      description,
      vendorId,
      departmentId,
      categoryId,
      typeId,
      season,
      cost,
      retail,
      width,
      depth,
      height,
      barcode,
    } = req.body;

    if (!name || !productNumber || !vendorId || !departmentId || !categoryId || !cost || !retail) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const vendorIdParsed = Number.parseInt(vendorId);
    const departmentIdParsed = Number.parseInt(departmentId);
    const categoryIdParsed = Number.parseInt(categoryId);
    const typeIdParsed = typeId ? Number.parseInt(typeId) : undefined;

    if (
      Number.isNaN(vendorIdParsed) ||
      Number.isNaN(departmentIdParsed) ||
      Number.isNaN(categoryIdParsed) ||
      (typeId && Number.isNaN(typeIdParsed!))
    ) {
      return res.status(400).json({ error: "Invalid ID provided" });
    }

    const costParsed = Number.parseFloat(cost);
    const retailParsed = Number.parseFloat(retail);

    if (Number.isNaN(costParsed) || Number.isNaN(retailParsed)) {
      return res.status(400).json({ error: "Invalid cost or retail value" });
    }

    // Check for existing product by unique composite key: productNumber + vendorId
    const existingProduct = await prisma.product.findFirst({
      where: {
        productNumber: productNumber,
        vendorId: vendorIdParsed,
      },
    });

    if (existingProduct) {
      return res
        .status(409)
        .json({ error: "A product with this Product # and Vendor already exists." });
    }

    const newProduct = await prisma.product.create({
      data: {
        name,
        productNumber,
        description,
        // Use relational connect for foreign keys
        vendor: { connect: { id: vendorIdParsed } },
        department: { connect: { id: departmentIdParsed } },
        category: { connect: { id: categoryIdParsed } },
        type: typeIdParsed ? { connect: { id: typeIdParsed } } : undefined,
        season: season || undefined,
        baseCost: costParsed,
        baseRetail: retailParsed,
        length: width || undefined, // Note: Mapping width to length, as per your schema, depth is used for casegoods
        depth: depth || undefined,
        height: height || undefined,
      },
    });

    if (barcode && barcode.trim() !== "") {
      await prisma.upc.create({
        data: {
          upc: barcode.trim(),
          product: { connect: { id: newProduct.id } },
          source: "MANUFACTURER",
        },
      });
    }

    return res.status(200).json({ success: true, productId: newProduct.id });
  } catch (err: unknown) {
    logError("Error creating product", err);
    // Provide a more specific error if a different unique constraint fails (like a barcode)
    if (getErrorCode(err) === "P2002") {
      return res.status(409).json({ error: "A product with this barcode may already exist." });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}
