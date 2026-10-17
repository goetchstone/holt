// /app/src/pages/api/vendors/[id].ts
//
// PATCH — update a vendor's pricing-behavior fields, contact details and lead
// time. MANAGER/ADMIN (was session-only with a raw req.body spread until the
// 2026-06-10 security sweep). Updatable fields are whitelisted in
// lib/vendorPatch.ts so a request can never touch columns the UI doesn't
// expose (name, isActive, audit fields, ...).

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import { parseVendorPatch } from "@/lib/vendorPatch";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vendorId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "Invalid vendor id" });
  }

  if (req.method === "PATCH") {
    const parsed = parseVendorPatch((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      const updated = await prisma.vendor.update({
        where: { id: vendorId },
        data: parsed.data,
      });
      return res.status(200).json(updated);
    } catch (err) {
      const code = getErrorCode(err);
      if (code === "P2025") return res.status(404).json({ error: "Vendor not found" });
      logError("Failed to update vendor", err);
      return res.status(500).json({ error: "Failed to update vendor" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("catalog.pricing", handler);
