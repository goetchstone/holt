// /app/src/pages/api/tax/districts/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const district = await prisma.taxDistrict.findUnique({
        where: { id },
        include: { zipCodes: { orderBy: { zipCode: "asc" } } },
      });
      if (!district) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(district);
    } catch (err) {
      logError("GET tax-district failed", err, { id });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { shortName, state, authority, name, reference, glAccountId, isActive, zipCodes } =
      req.body;

    if (!shortName?.trim() || !state?.trim() || !name?.trim()) {
      return res.status(400).json({ error: "Short name, state, and name are required" });
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const district = await tx.taxDistrict.update({
          where: { id },
          data: {
            shortName: shortName.trim(),
            state: state.trim(),
            authority: authority?.trim() || null,
            name: name.trim(),
            reference: reference?.trim() || null,
            glAccountId: glAccountId ? Number.parseInt(glAccountId) : null,
            isActive: isActive !== false,
          },
        });

        // Replace ZIP codes if provided
        if (Array.isArray(zipCodes)) {
          await tx.taxDistrictZipCode.deleteMany({ where: { districtId: id } });
          if (zipCodes.length > 0) {
            await tx.taxDistrictZipCode.createMany({
              data: zipCodes.map((z: string) => ({
                districtId: id,
                zipCode: z.trim(),
              })),
            });
          }
        }

        return tx.taxDistrict.findUnique({
          where: { id },
          include: { zipCodes: { orderBy: { zipCode: "asc" } } },
        });
      });

      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `District "${shortName}" already exists.` });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("PUT tax-district failed", err, { id });
      return res.status(500).json({ error: "Failed to update district" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const ruleCount = await prisma.taxRule.count({ where: { districtId: id } });
      if (ruleCount > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${ruleCount} tax rule${ruleCount !== 1 ? "s" : ""} reference this district.`,
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.taxDistrictZipCode.deleteMany({ where: { districtId: id } });
        await tx.taxDistrict.delete({ where: { id } });
      });

      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("DELETE tax-district failed", err, { id });
      return res.status(500).json({ error: "Failed to delete district" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
