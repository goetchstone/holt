// /app/src/pages/api/vendors/[id].ts
//
// PATCH — update a vendor's pricing-behavior fields. MANAGER/ADMIN (was
// session-only with a raw req.body spread until the 2026-06-10 security
// sweep). Updatable fields are whitelisted so a request can never touch
// columns the UI doesn't expose (name, isActive, audit fields, ...).

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import type { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vendorId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "Invalid vendor id" });
  }

  if (req.method === "PATCH") {
    try {
      const { defaultMarkup, defaultDiscount, mapEnforced, allowTradeDiscount } = req.body as {
        defaultMarkup?: number | null;
        defaultDiscount?: number | null;
        mapEnforced?: boolean;
        allowTradeDiscount?: boolean;
      };
      const data: Prisma.VendorUpdateInput = {};
      if (defaultMarkup !== undefined) data.defaultMarkup = defaultMarkup;
      if (defaultDiscount !== undefined) data.defaultDiscount = defaultDiscount;
      if (typeof mapEnforced === "boolean") data.mapEnforced = mapEnforced;
      if (typeof allowTradeDiscount === "boolean") data.allowTradeDiscount = allowTradeDiscount;
      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "No updatable fields in request" });
      }
      const updated = await prisma.vendor.update({
        where: { id: vendorId },
        data,
      });
      return res.status(200).json(updated);
    } catch (err) {
      logError("Failed to update vendor", err);
      return res.status(500).json({ error: "Failed to update vendor" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
