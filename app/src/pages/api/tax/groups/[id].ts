// /app/src/pages/api/tax/groups/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const group = await prisma.taxGroup.findUnique({ where: { id } });
      if (!group) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(group);
    } catch (err) {
      logError(`GET /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { name, taxBasis, freightTaxable, miscTaxable, exempt } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    try {
      const updated = await prisma.taxGroup.update({
        where: { id },
        data: {
          name: name.trim(),
          taxBasis: taxBasis || "NET",
          freightTaxable: !!freightTaxable,
          miscTaxable: !!miscTaxable,
          exempt: !!exempt,
        },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Tax group "${name}" already exists.` });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`PUT /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Failed to update tax group" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const ruleCount = await prisma.taxRule.count({ where: { groupId: id } });
      if (ruleCount > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${ruleCount} tax rule${ruleCount !== 1 ? "s" : ""} reference this group.`,
        });
      }
      // A category or product taxed under this group would silently fall back
      // to its district's rules (the FK is SET NULL), so refuse instead.
      const [categoryCount, productCount] = await Promise.all([
        prisma.category.count({ where: { taxGroupId: id } }),
        prisma.product.count({ where: { taxGroupId: id } }),
      ]);
      if (categoryCount + productCount > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${categoryCount} categor${categoryCount !== 1 ? "ies" : "y"} and ${productCount} product${productCount !== 1 ? "s" : ""} sell under this group.`,
        });
      }
      // Delivery fees too (AppSettings.deliveryFeeTaxGroupId): the same SET
      // NULL would quietly tax them by the district's rules.
      const deliverySettings = await prisma.appSettings.count({
        where: { deliveryFeeTaxGroupId: id },
      });
      if (deliverySettings > 0) {
        return res.status(409).json({
          error:
            "Cannot delete: delivery fees sell under this group. Choose another in Admin › Settings › Sales tax first.",
        });
      }

      await prisma.taxGroup.delete({ where: { id } });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`DELETE /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Failed to delete tax group" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("admin.settings", handler);
