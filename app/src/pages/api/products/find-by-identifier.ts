// /app/src/pages/api/products/find-by-identifier.ts
//
// A scan or typed number to its product. baseRetail in the answer is the price
// the register charges TODAY -- a sale price while the product's scheduled sale
// is on (lib/pricing/salePrice.ts, GAP-06 part B) -- with regularRetail, onSale
// and saleEndsOn beside it, and tradeEligible and tradeDiscountOnSaleItems for
// a trade customer's price (GAP-06 part C), as GET /api/products answers.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import type { Product } from "@prisma/client";
import { saleToday } from "@/lib/pricing/salePrice";
import { screenPriceFields } from "@/lib/pricing/screenPricing";

/**
 * The product as the screens read it: its price today, sale or not, and whether
 * a customer's trade tier may discount it (lib/pricing/screenPricing.ts).
 */
async function withTodaysPrice(product: Product) {
  const fields = await screenPriceFields(prisma, [product], await saleToday());
  return { ...product, ...fields.get(product.id)! };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORRECTED: This API now accepts both GET and POST requests to be more resilient.
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // Determine the identifier based on the request method
  let identifier: string | undefined;
  if (req.method === "GET") {
    identifier = req.query.identifier as string;
  } else {
    // POST
    identifier = req.body.identifier as string;
  }

  if (!identifier || typeof identifier !== "string") {
    return res.status(400).json({ error: "Identifier is required" });
  }

  const sanitizedIdentifier = identifier.trim();

  if (!sanitizedIdentifier) {
    return res.status(400).json({ error: "Identifier is required" });
  }

  try {
    // The robust, sequential search logic remains the same.
    // Step 1: Search UPCs first.
    const upc = await prisma.upc.findFirst({
      where: {
        upc: {
          equals: sanitizedIdentifier,
          mode: "insensitive",
        },
      },
      include: { product: true },
    });

    if (upc && upc.product) {
      return res.status(200).json(await withTodaysPrice(upc.product));
    }

    // Step 2: If no UPC, search Product Numbers.
    const product = await prisma.product.findFirst({
      where: {
        productNumber: {
          equals: sanitizedIdentifier,
          mode: "insensitive",
        },
      },
    });

    if (product) {
      return res.status(200).json(await withTodaysPrice(product));
    }

    return res
      .status(404)
      .json({ error: `Product not found for identifier: "${sanitizedIdentifier}"` });
  } catch (error) {
    logError("Find product by identifier error", error);
    res.status(500).json({ error: "An internal server error occurred." });
  }
}

// catalog.read, not catalog.write: this is a lookup, and the POS (pos.operate)
// and physical count (inventory.count) scan through it. REGISTER and WAREHOUSE
// hold neither catalog.write, so every barcode scan at the register and every
// count scan 403'd. Every pos.operate and inventory.count holder holds
// catalog.read.
export default requirePermission("catalog.read", handler);
