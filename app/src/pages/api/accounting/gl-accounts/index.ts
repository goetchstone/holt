// /app/src/pages/api/accounting/gl-accounts/index.ts

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
      const accounts = await prisma.gLAccount.findMany({
        orderBy: { code: "asc" },
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

      const result = accounts.map((a) => ({
        ...a,
        _count: {
          taxDistricts: a._count.taxDistricts,
          accountGroups:
            a._count.accountGroupCogs +
            a._count.accountGroupInventory +
            a._count.accountGroupSales +
            a._count.accountGroupReturns +
            a._count.accountGroupTransfers +
            a._count.accountGroupShrinkage,
        },
      }));

      return res.status(200).json(result);
    } catch (err) {
      logError("GET /accounting/gl-accounts error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    const { code, name, accountType } = req.body;

    if (!code || !name || !accountType) {
      return res.status(400).json({ error: "Code, name, and account type are required" });
    }

    try {
      const account = await prisma.gLAccount.create({
        data: { code, name, accountType },
      });
      return res.status(201).json(account);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "An account with this code already exists." });
      }
      logError("POST /accounting/gl-accounts error", err);
      return res.status(500).json({ error: "Failed to create GL account" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

// The list serves the Chart of Accounts screen and the GL picker in the tax
// district editor (both Manage configuration), so a GET takes that key, View
// accounting, or the write key. Creating an account is chart setup: the
// screen's key, or "Set up the chart of accounts", which Managers hold (they
// made these writes by API under the old MANAGER/ADMIN list).
export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requirePermission(
      { anyOf: ["admin.config", "accounting.chart.manage", "accounting.read"] },
      handler,
    )(req, res);
  }
  return requirePermission({ anyOf: ["admin.config", "accounting.chart.manage"] }, handler)(
    req,
    res,
  );
}
