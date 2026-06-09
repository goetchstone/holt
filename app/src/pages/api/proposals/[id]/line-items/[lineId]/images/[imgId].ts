// /app/src/pages/api/proposals/[id]/line-items/[lineId]/images/[imgId].ts
//
// DELETE: Remove an image from a proposal line item.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import fs from "fs";
import path from "path";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "DELETE") {
      res.setHeader("Allow", ["DELETE"]);
      return res.status(405).end();
    }

    const imgId = Number.parseInt(req.query.imgId as string, 10);
    if (Number.isNaN(imgId)) return res.status(400).json({ error: "Invalid image ID" });

    try {
      const image = await prisma.proposalItemImage.findUnique({
        where: { id: imgId },
        select: { imageUrl: true },
      });
      if (!image) return res.status(404).json({ error: "Image not found" });

      // Delete file from disk. imageUrl is DB-controlled but we still
      // guard with safePathJoin for defense in depth.
      const dataRoot = path.join(process.cwd(), "data");
      try {
        const filePath = safePathJoin(dataRoot, image.imageUrl);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (err) {
        if (!(err instanceof PathTraversalError)) throw err;
        // Skip the disk cleanup but still remove the DB row below.
      }

      await prisma.proposalItemImage.delete({ where: { id: imgId } });
      return res.status(200).json({ deleted: true });
    } catch (err: unknown) {
      logError("Failed to delete proposal image", err);
      return res.status(500).json({ error: "Failed to delete image" });
    }
  },
);
