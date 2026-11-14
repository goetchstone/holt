// /app/src/pages/api/vendors/[id].ts
//
// PATCH — update a vendor's pricing-behavior fields, contact details and lead
// time. MANAGER/ADMIN (was session-only with a raw req.body spread until the
// 2026-06-10 security sweep). Updatable fields are whitelisted in
// lib/vendorPatch.ts so a request can never touch columns the UI doesn't
// expose (name, isActive, audit fields, ...).

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import { parseVendorPatch } from "@/lib/vendorPatch";
import { auditActor, auditLog } from "@/lib/audit";
import { sameMarkup } from "@/lib/pricing/markup";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const vendorId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "Invalid vendor id" });
  }

  if (req.method === "PATCH") {
    const parsed = parseVendorPatch((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.vendor.findUnique({
          where: { id: vendorId },
          select: { defaultMarkup: true },
        });
        const after = await tx.vendor.update({ where: { id: vendorId }, data: parsed.data });
        // A vendor's markup prices its catalog (lib/pricing/markup.ts): who moved it is recorded.
        if (before && "defaultMarkup" in parsed.data) {
          const from = before.defaultMarkup == null ? null : Number(before.defaultMarkup);
          const to = after.defaultMarkup == null ? null : Number(after.defaultMarkup);
          if (!sameMarkup(from, to)) {
            await auditLog(
              "MARKUP_CHANGED",
              auditActor(session),
              {
                summary: `${after.name}: vendor markup ${from ?? "none"} → ${to ?? "none"}`,
                target: { type: "vendor", id: vendorId },
                details: { scope: "vendor", from, to },
              },
              tx,
            );
          }
        }
        return after;
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
