// /app/src/pages/api/accounting/gl-accounts/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const account = await prisma.gLAccount.findUnique({ where: { id } });
      if (!account) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(account);
    } catch (err) {
      logError("GET gl-account failed", err, { id });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { code, name, accountType, isActive } = req.body;

    if (!code || !name || !accountType) {
      return res.status(400).json({ error: "Code, name, and account type are required" });
    }

    try {
      const account = await prisma.gLAccount.update({
        where: { id },
        data: { code, name, accountType, isActive: isActive !== false },
      });
      return res.status(200).json(account);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "An account with this code already exists." });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("PUT gl-account failed", err, { id });
      return res.status(500).json({ error: "Failed to update GL account" });
    }
  }

  if (req.method === "DELETE") {
    try {
      // Block deletion if referenced by account groups or tax districts
      const refs = await prisma.gLAccount.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              taxDistricts: true,
              accountGroupCogs: true,
              accountGroupInventory: true,
              accountGroupSales: true,
              accountGroupReturns: true,
              accountGroupTransfers: true,
              accountGroupShrinkage: true,
            },
          },
        },
      });

      if (!refs) return res.status(404).json({ error: "Not found" });

      const totalRefs =
        refs._count.taxDistricts +
        refs._count.accountGroupCogs +
        refs._count.accountGroupInventory +
        refs._count.accountGroupSales +
        refs._count.accountGroupReturns +
        refs._count.accountGroupTransfers +
        refs._count.accountGroupShrinkage;

      if (totalRefs > 0) {
        return res
          .status(409)
          .json({ error: "Cannot delete: this account is referenced by other records." });
      }

      await prisma.gLAccount.delete({ where: { id } });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("DELETE gl-account failed", err, { id });
      return res.status(500).json({ error: "Failed to delete GL account" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
