// /app/src/pages/api/tax/rules/index.ts

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

  if (req.method === "GET") {
    try {
      const districtId = req.query.districtId
        ? Number.parseInt(req.query.districtId as string)
        : undefined;
      const groupId = req.query.groupId ? Number.parseInt(req.query.groupId as string) : undefined;

      const where: Record<string, number> = {};
      if (districtId) where.districtId = districtId;
      if (groupId) where.groupId = groupId;

      const rules = await prisma.taxRule.findMany({
        where,
        orderBy: [{ districtId: "asc" }, { groupId: "asc" }, { sortOrder: "asc" }],
        include: {
          district: { select: { shortName: true, name: true } },
          group: { select: { name: true } },
        },
      });

      const result = rules.map((r) => ({
        ...r,
        taxRate: toNumber(r.taxRate),
        triggerPrice: toNumber(r.triggerPrice),
        startPrice: toNumber(r.startPrice),
        stopPrice: toNumber(r.stopPrice),
        triggerStop: toNumber(r.triggerStop),
      }));

      return res.status(200).json(result);
    } catch (err) {
      logError("GET /tax/rules error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
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
    } = req.body;

    if (!districtId || !groupId || taxRate === undefined || taxRate === null) {
      return res.status(400).json({ error: "District, group, and tax rate are required" });
    }

    try {
      const rule = await prisma.taxRule.create({
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
        },
        include: {
          district: { select: { shortName: true, name: true } },
          group: { select: { name: true } },
        },
      });

      return res.status(201).json({
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
      if (getErrorCode(err) === "P2003") {
        return res.status(409).json({ error: "Referenced district or group does not exist." });
      }
      logError("POST /tax/rules error", err);
      return res.status(500).json({ error: "Failed to create tax rule" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
