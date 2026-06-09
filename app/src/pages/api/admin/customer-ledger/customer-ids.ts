// /app/src/pages/api/admin/customer-ledger/customer-ids.ts
//
// Returns the full list of Customer ids in stable order. Used by the backfill
// admin page to chunk through customers in batches that each fit inside the
// nginx 300s proxy timeout — running every customer in one synchronous POST
// blew past the timeout in prod (~14K customers).
//
// Cheap query: ids only, no joins. ADMIN-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["ADMIN"],
  async (_req: NextApiRequest, res: NextApiResponse) => {
    try {
      const customers = await prisma.customer.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
      });
      const ids = customers.map((c) => c.id);
      return res.status(200).json({ ids, total: ids.length });
    } catch (err) {
      logError("customer-ledger customer-ids list failed", err);
      return res.status(500).json({ error: "Failed to list customer ids" });
    }
  },
);
