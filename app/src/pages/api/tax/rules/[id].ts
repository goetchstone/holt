// /app/src/pages/api/tax/rules/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const rule = await prisma.taxRule.findUnique({
        where: { id },
        include: {
          district: { select: { shortName: true, name: true } },
          group: { select: { name: true } },
        },
      });
      if (!rule) return res.status(404).json({ error: "Not found" });

      return res.status(200).json({
        ...rule,
        taxRate: toNumber(rule.taxRate),
        triggerPrice: toNumber(rule.triggerPrice),
        startPrice: toNumber(rule.startPrice),
        stopPrice: toNumber(rule.stopPrice),
        triggerStop: toNumber(rule.triggerStop),
      });
    } catch (err) {
      logError(`GET /tax/rules/${id} error`, err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const {
      districtId,
      groupId,
      taxRate,
      triggerPrice,
      startPrice,
      stopPrice,
      triggerStop,
      taxIncludedInSalesPrice,
      ruleToAddBeforeCalcId,
      sortOrder,
      isActive,
    } = req.body;

    if (!districtId || !groupId || taxRate === undefined || taxRate === null) {
      return res.status(400).json({ error: "District, group, and tax rate are required" });
    }

    try {
      const rule = await prisma.taxRule.update({
        where: { id },
        data: {
          districtId: Number.parseInt(districtId),
          groupId: Number.parseInt(groupId),
          taxRate: Number.parseFloat(taxRate),
          triggerPrice: triggerPrice != null ? Number.parseFloat(triggerPrice) : null,
          startPrice: startPrice != null ? Number.parseFloat(startPrice) : null,
          stopPrice: stopPrice != null ? Number.parseFloat(stopPrice) : null,
          triggerStop: triggerStop != null ? Number.parseFloat(triggerStop) : null,
          taxIncludedInSalesPrice: !!taxIncludedInSalesPrice,
          ruleToAddBeforeCalcId: ruleToAddBeforeCalcId
            ? Number.parseInt(ruleToAddBeforeCalcId)
            : null,
          sortOrder: Number.parseInt(sortOrder) || 0,
          isActive: isActive !== false,
        },
        include: {
          district: { select: { shortName: true, name: true } },
          group: { select: { name: true } },
        },
      });

      return res.status(200).json({
        ...rule,
        taxRate: toNumber(rule.taxRate),
        triggerPrice: toNumber(rule.triggerPrice),
        startPrice: toNumber(rule.startPrice),
        stopPrice: toNumber(rule.stopPrice),
        triggerStop: toNumber(rule.triggerStop),
      });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res
          .status(409)
          .json({ error: "A rule with this district, group, and sort order already exists." });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`PUT /tax/rules/${id} error`, err);
      return res.status(500).json({ error: "Failed to update tax rule" });
    }
  }

  if (req.method === "DELETE") {
    try {
      // Nullify any chain references to this rule before deleting
      await prisma.taxRule.updateMany({
        where: { ruleToAddBeforeCalcId: id },
        data: { ruleToAddBeforeCalcId: null },
      });

      await prisma.taxRule.delete({ where: { id } });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`DELETE /tax/rules/${id} error`, err);
      return res.status(500).json({ error: "Failed to delete tax rule" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
