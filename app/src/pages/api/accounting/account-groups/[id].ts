// /app/src/pages/api/accounting/account-groups/[id].ts

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
      const group = await prisma.accountGroup.findUnique({
        where: { id },
        include: {
          cogsAccount: { select: { code: true, name: true } },
          inventoryAccount: { select: { code: true, name: true } },
          salesAccount: { select: { code: true, name: true } },
          returnsAccount: { select: { code: true, name: true } },
          transfersAccount: { select: { code: true, name: true } },
          shrinkageAccount: { select: { code: true, name: true } },
        },
      });
      if (!group) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(group);
    } catch (err) {
      logError("GET account-group failed", err, { id });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const {
      name,
      description,
      cogsAccountId,
      inventoryAccountId,
      salesAccountId,
      returnsAccountId,
      transfersAccountId,
      shrinkageAccountId,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    try {
      const group = await prisma.accountGroup.update({
        where: { id },
        data: {
          name,
          description: description || null,
          cogsAccountId: cogsAccountId ? Number.parseInt(cogsAccountId) : null,
          inventoryAccountId: inventoryAccountId ? Number.parseInt(inventoryAccountId) : null,
          salesAccountId: salesAccountId ? Number.parseInt(salesAccountId) : null,
          returnsAccountId: returnsAccountId ? Number.parseInt(returnsAccountId) : null,
          transfersAccountId: transfersAccountId ? Number.parseInt(transfersAccountId) : null,
          shrinkageAccountId: shrinkageAccountId ? Number.parseInt(shrinkageAccountId) : null,
        },
        include: {
          cogsAccount: { select: { code: true, name: true } },
          inventoryAccount: { select: { code: true, name: true } },
          salesAccount: { select: { code: true, name: true } },
          returnsAccount: { select: { code: true, name: true } },
          transfersAccount: { select: { code: true, name: true } },
          shrinkageAccount: { select: { code: true, name: true } },
        },
      });
      return res.status(200).json(group);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "An account group with this name already exists." });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("PUT account-group failed", err, { id });
      return res.status(500).json({ error: "Failed to update account group" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const group = await prisma.accountGroup.findUnique({
        where: { id },
        include: { _count: { select: { categories: true } } },
      });
      if (!group) return res.status(404).json({ error: "Not found" });

      if (group._count.categories > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${group._count.categories} categor${group._count.categories === 1 ? "y" : "ies"} reference this account group.`,
        });
      }

      await prisma.accountGroup.delete({ where: { id } });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("DELETE account-group failed", err, { id });
      return res.status(500).json({ error: "Failed to delete account group" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
