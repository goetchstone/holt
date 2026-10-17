// /app/src/pages/api/products/[id].ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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
        boxesPerUnit: product.boxesPerUnit,
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
    // The body must be a JSON object. `length` below is the product's length
    // field, but on an array or string body it is the body's own length: a
    // PATCH of `[1,2,3]` set the product's length to 3 (CodeQL
    // js/type-confusion-through-parameter-tampering #18).
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
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
        boxesPerUnit,
        serviceType,
      } = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- same untyped shape req.body had

      const validServiceTypes = ["MEASURE", "INSTALL", "DELIVERY", "HOUSE_CALL"];
      const resolvedServiceType =
        serviceType && validServiceTypes.includes(serviceType) ? serviceType : null;

      const parseOptionalFloat = (val: unknown): number | null | undefined => {
        if (val === undefined) return undefined;
        if (val === null || val === "") return null;
        const num = Number.parseFloat(String(val));
        return Number.isNaN(num) ? null : num;
      };

      // How many boxes one unit ships in: a whole number from 1 to 99, or
      // cleared (one box). Box labels and box scans count against it.
      let boxes: number | null | undefined;
      if (boxesPerUnit === undefined) boxes = undefined;
      else if (boxesPerUnit === null || boxesPerUnit === "") boxes = null;
      else {
        const n = Number(boxesPerUnit);
        if (!Number.isInteger(n) || n < 1 || n > 99) {
          return res
            .status(400)
            .json({ error: "Boxes per unit must be a whole number from 1 to 99." });
        }
        boxes = n;
      }

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
          boxesPerUnit: boxes,
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

export default requirePermission("catalog.write", handler);
