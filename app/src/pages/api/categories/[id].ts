// /app/src/pages/api/categories/[id].ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import { readTaxGroupId } from "@/lib/tax/taxGroupInput";
import type { Session } from "next-auth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { auditActor, auditLog } from "@/lib/audit";
import { markupProblem, sameMarkup } from "@/lib/pricing/markup";

/** A category's markup prices its products: changing it needs "Change pricing". */
const PRICING = "catalog.pricing";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid category ID" });

  if (req.method === "GET") {
    try {
      const category = await prisma.category.findUnique({
        where: { id },
        include: {
          department: true,
          labelTemplate: true,
          accountGroup: { select: { id: true, name: true } },
        },
      });
      if (!category) return res.status(404).json({ error: "Category not found" });
      return res.status(200).json(category);
    } catch (err) {
      logError("GET /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { name, departmentId, trackInventory, accountGroupId, labelTemplateId } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!departmentId || Number.isNaN(Number.parseInt(departmentId))) {
      return res.status(400).json({ error: "Valid department ID is required" });
    }
    const taxGroup = await readTaxGroupId(prisma, req.body.taxGroupId);
    if ("error" in taxGroup) return res.status(400).json({ error: taxGroup.error });
    // Its markup (GAP-06): a multiplier, null to follow the vendor's or the
    // store's, or absent to leave it -- the other editors of a category send
    // no markup and must not clear it.
    const markup: unknown = req.body.defaultMarkup === "" ? null : req.body.defaultMarkup;
    if (markup !== undefined) {
      const problem = markupProblem(markup);
      if (problem) return res.status(400).json({ error: problem });
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.category.findUnique({
          where: { id },
          select: { name: true, defaultMarkup: true },
        });
        const markupMoves =
          before !== null && markup !== undefined && !sameMarkup(before.defaultMarkup, markup);
        if (markupMoves && !access.holds[PRICING]) return "NEEDS_PRICING" as const;
        const after = await tx.category.update({
          where: { id },
          data: {
            name,
            departmentId: Number.parseInt(departmentId),
            trackInventory: trackInventory ?? true,
            accountGroupId: accountGroupId ? Number.parseInt(accountGroupId) : null,
            labelTemplateId: labelTemplateId ? Number.parseInt(labelTemplateId) : null,
            // Only when sent: this PUT otherwise replaces the whole row.
            ...(taxGroup.value !== undefined && { taxGroupId: taxGroup.value }),
            ...(markupMoves && { defaultMarkup: markup as number | null }),
          },
        });
        if (markupMoves) {
          const from = before.defaultMarkup == null ? null : Number(before.defaultMarkup);
          await auditLog(
            "MARKUP_CHANGED",
            auditActor(session),
            {
              summary: `${after.name}: category markup ${from ?? "none"} → ${markup ?? "none"}`,
              details: { scope: "category", categoryId: id, from, to: markup as number | null },
            },
            tx,
          );
        }
        return after;
      });
      if (updated === "NEEDS_PRICING") {
        return res
          .status(403)
          .json({ error: "Changing a category's markup needs the Change pricing permission." });
      }
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Category not found" });
      }
      if (getErrorCode(err) === "P2002") {
        return res
          .status(409)
          .json({ error: `Category "${name}" already exists in this department` });
      }
      logError("PUT /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "DELETE") {
    try {
      await prisma.category.delete({ where: { id } });
      return res.status(204).end();
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Category not found" });
      }
      if (getErrorCode(err) === "P2003") {
        return res.status(409).json({
          error: "Cannot delete category: it is associated with products or other records.",
        });
      }
      logError("DELETE /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("catalog.write", handler, { also: [PRICING] });
