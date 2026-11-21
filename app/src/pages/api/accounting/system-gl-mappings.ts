// /app/src/pages/api/accounting/system-gl-mappings.ts

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
      const mappings = await prisma.systemGLMapping.findMany({
        orderBy: [{ section: "asc" }, { label: "asc" }],
        include: { glAccount: { select: { id: true, code: true, name: true } } },
      });
      return res.status(200).json(mappings);
    } catch (err) {
      logError("GET /accounting/system-gl-mappings error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { id, glAccountId } = req.body;
    if (!id) return res.status(400).json({ error: "Mapping ID is required" });

    try {
      const updated = await prisma.systemGLMapping.update({
        where: { id: Number.parseInt(id) },
        data: { glAccountId: glAccountId ? Number.parseInt(glAccountId) : null },
        include: { glAccount: { select: { id: true, code: true, name: true } } },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return res.status(404).json({ error: "Not found" });
      logError("PUT /accounting/system-gl-mappings error", err);
      return res.status(500).json({ error: "Failed to update mapping" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

// Pointing a payment type or system line at a GL account decides where every
// later journal books that money: chart setup, on the Chart of Accounts
// screen's key or "Set up the chart of accounts", which Managers hold (they
// made this change by API under the old MANAGER/ADMIN list). Reading the
// mappings also takes View accounting.
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
