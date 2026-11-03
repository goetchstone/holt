// /app/src/pages/api/products/[id]/picture.ts
//
// GAP-07: a product's picture, printed beside its lines on the invoice
// (lib/sales/linePicture.ts). POST uploads one (the IMAGE preset: jpeg, png,
// webp or heic) into data/uploads/images/products/ and points imageUrl at it,
// replacing whatever was there -- a photo, or the line drawing a price-list
// import extracted. DELETE clears it. Gated like editing the product.
//
// No file is ever deleted here: an extracted line drawing is the vendor style's
// too, and a custom product configured from this one copied its imageUrl
// (create-from-cart), so the old file may still be someone's picture.

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { createSecureForm } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";

export const config = {
  api: { bodyParser: false },
};

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid product ID" });
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", ["POST", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  if (!product) return res.status(404).json({ error: "Product not found" });

  try {
    if (req.method === "DELETE") {
      await prisma.product.update({ where: { id }, data: { imageUrl: null } });
      return res.status(200).json({ imageUrl: null });
    }
    const form = createSecureForm("IMAGE", {
      subPath: "products",
      filename: (_original, ext) => `product-${id}-${Date.now()}${ext}`,
    });
    const [, files] = await form.parse(req);
    const file = files.file?.[0];
    // The preset's filter drops a file of any other type before it is written.
    if (!file) {
      return res.status(400).json({ error: "Upload a JPEG, PNG, WebP or HEIC picture." });
    }
    const imageUrl = `/uploads/images/products/${path.basename(file.filepath)}`;
    await prisma.product.update({ where: { id }, data: { imageUrl } });
    return res.status(200).json({ imageUrl });
  } catch (err) {
    logError(`${req.method} /api/products/[id]/picture error`, err, { id });
    return res.status(500).json({ error: "Failed to save the picture" });
  }
}

export default requirePermission("catalog.write", handler);
