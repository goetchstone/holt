// /app/src/pages/api/products/[id].ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  const productId = Number.parseInt(id as string);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

  if (req.method === "GET") {
    try {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          vendor: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          type: { select: { id: true, name: true } },
          collection: { select: { id: true, name: true } },
          upcs: { orderBy: { sortOrder: "asc" } },
          vendorStyle: { select: { id: true, styleNumber: true, name: true } },
        },
      });

      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      return res.status(200).json({
        id: product.id,
        externalId: product.externalId,
        productNumber: product.productNumber,
        name: product.name,
        description: product.description,
        season: product.season,
        imageUrl: product.imageUrl,
        isActive: product.isActive,
        isDiscontinued: product.isDiscontinued,
        baseCost: product.baseCost != null ? Number(product.baseCost) : null,
        baseRetail: product.baseRetail != null ? Number(product.baseRetail) : null,
        mapPrice: product.mapPrice != null ? Number(product.mapPrice) : null,
        length: product.length,
        width: product.width,
        depth: product.depth,
        height: product.height,
        weight: product.weight,
        cubicFeet: product.cubicFeet,
        seatHeight: product.seatHeight,
        armHeight: product.armHeight,
        seatDepth: product.seatDepth,
        freightClass: product.freightClass,
        shipsVia: product.shipsVia,
        cartonQty: product.cartonQty,
        vendor: product.vendor,
        department: product.department,
        category: product.category,
        type: product.type,
        collection: product.collection,
        vendorStyle: product.vendorStyle,
        upcs: product.upcs.map((u) => ({ id: u.id, upc: u.upc })),
        created: product.created,
        serviceType: product.serviceType,
        updated: product.updated,
      });
    } catch (error) {
      logError("Error fetching product", error);
      return res.status(500).json({ error: "Failed to fetch product" });
    }
  } else if (req.method === "PATCH") {
    try {
      const {
        name,
        productNumber,
        description,
        season,
        baseRetail,
        length,
        depth,
        height,
        serviceType,
      } = req.body;

      const validServiceTypes = ["MEASURE", "INSTALL", "DELIVERY", "HOUSE_CALL"];
      const resolvedServiceType =
        serviceType && validServiceTypes.includes(serviceType) ? serviceType : null;

      const parseOptionalFloat = (val: unknown): number | null | undefined => {
        if (val === undefined) return undefined;
        if (val === null || val === "") return null;
        const num = Number.parseFloat(String(val));
        return Number.isNaN(num) ? null : num;
      };

      const updatedProduct = await prisma.product.update({
        where: { id: productId },
        data: {
          name: name || undefined,
          productNumber: productNumber || undefined,
          description: description === "" ? null : description,
          season: season === "" ? null : season,
          baseRetail: parseOptionalFloat(baseRetail),
          length: parseOptionalFloat(length),
          depth: parseOptionalFloat(depth),
          height: parseOptionalFloat(height),
          serviceType: resolvedServiceType,
        },
      });

      return res.status(200).json(updatedProduct);
    } catch (err) {
      logError("Error updating product", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  } else {
    return res.status(405).end();
  }
}
