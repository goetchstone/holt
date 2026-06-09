// /app/src/pages/api/scheduling/windows/[id].ts
//
// Delete a single availability window (admin).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "DELETE") {
      res.setHeader("Allow", ["DELETE"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.availabilityWindow.findFirst({
      where: { id, organizationId: DEFAULT_ORG_ID },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "Window not found" });

    await prisma.availabilityWindow.delete({ where: { id } });
    return res.status(204).end();
  },
);
