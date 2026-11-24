// /app/src/pages/api/accounting/account-groups/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const groups = await prisma.accountGroup.findMany({
        orderBy: { name: "asc" },
        include: {
          cogsAccount: { select: { code: true, name: true } },
          inventoryAccount: { select: { code: true, name: true } },
          salesAccount: { select: { code: true, name: true } },
          returnsAccount: { select: { code: true, name: true } },
          transfersAccount: { select: { code: true, name: true } },
          shrinkageAccount: { select: { code: true, name: true } },
        },
      });
      return res.status(200).json(groups);
    } catch (err) {
      logError("GET /accounting/account-groups error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
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
      const group = await prisma.accountGroup.create({
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
      return res.status(201).json(group);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "An account group with this name already exists." });
      }
      logError("POST /accounting/account-groups error", err);
      return res.status(500).json({ error: "Failed to create account group" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

// The list serves the Chart of Accounts screen and the Account Group picker on
// the category editor, so a GET takes either screen's key (Edit catalog for the
// picker, as /api/tax/groups does), View accounting, or the write key. Creating
// a group is chart setup: the screen's key, or "Set up the chart of accounts",
// which Managers hold (they made these writes by API under the old MANAGER/ADMIN
// list).
export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission(
      { anyOf: ["admin.config", "accounting.chart.manage", "accounting.read", "catalog.write"] },
      handler,
    )(req, res);
  }
  return requirePermission({ anyOf: ["admin.config", "accounting.chart.manage"] }, handler)(
    req,
    res,
  );
}
