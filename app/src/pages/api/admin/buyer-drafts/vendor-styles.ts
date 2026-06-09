// /app/src/pages/api/admin/buyer-drafts/vendor-styles.ts
//
// VendorStyle catalog lookup for the buyer-drafts wizard's "Pick from
// catalog" flow. ADMIN-only.
//
// Returns active VendorStyles for a given vendor with the fields the
// wizard needs to pre-fill: styleNumber, name, baseCost, baseRetail,
// dimensions, plus the linked taxonomy.
//
// The wizard uses this so the buyer doesn't have to re-type known catalog
// data when drafting an item that's based on an existing vendor style —
// they pick from the list, the wizard fills the structured fields and
// pricing, and they edit only what's specific to this draft.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const vendorIdRaw = Number.parseInt(String(req.query.vendorId), 10);
  if (!Number.isInteger(vendorIdRaw)) {
    return res.status(400).json({ error: "vendorId is required" });
  }

  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";

  try {
    const styles = await prisma.vendorStyle.findMany({
      where: {
        vendorId: vendorIdRaw,
        isActive: true,
        ...(search
          ? {
              OR: [
                { styleNumber: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        styleNumber: true,
        name: true,
        description: true,
        baseCost: true,
        baseRetail: true,
        length: true,
        width: true,
        depth: true,
        height: true,
        imageUrl: true,
        isDiscontinued: true,
        department: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        type: { select: { id: true, name: true } },
      },
      orderBy: [{ styleNumber: "asc" }],
      take: 500,
    });

    return res.status(200).json({ styles });
  } catch (err) {
    logError("buyer-drafts vendor-styles failed", err);
    return res.status(500).json({ error: "Failed to load vendor styles" });
  }
});
