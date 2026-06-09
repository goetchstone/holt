// /app/src/pages/api/customers/[id]/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Wealth enrichment data (net worth, wealth tier, lifestyle signals)
// lives on Customer via the `windfallEnrichment` relation. Only ADMIN
// and MARKETING may see wealth fields — everyone else gets the customer
// record with the enrichment relation stripped out server-side.
// SUPER_ADMIN (owner role above ADMIN) sees wealth fields too.
const WEALTH_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MARKETING"]);

export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "MARKETING", "REGISTER", "INSTALLER"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const { id } = req.query;
    if (!id) {
      return res.status(400).json({ error: "Customer ID is required." });
    }

    const customerId = Number.parseInt(id as string);
    if (Number.isNaN(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    if (req.method === "GET") {
      try {
        const role = (session as unknown as { role?: string })?.role ?? "";
        const canSeeWealth = WEALTH_ROLES.has(role);

        const customer = await prisma.customer.findUnique({
          where: { id: customerId },
          include: {
            addresses: true,
            externalIds: true,
            tradeTier: true,
            windfallEnrichment: canSeeWealth,
            salesOrders: {
              include: {
                lineItems: true,
                payments: true,
              },
              orderBy: {
                orderDate: "desc",
              },
            },
          },
        });

        if (!customer) {
          return res.status(404).json({ error: "Customer not found." });
        }

        return res.status(200).json(customer);
      } catch (error) {
        logError("Fetch customer details failed", error, { customerId });
        return res.status(500).json({ error: "Failed to fetch customer details." });
      }
    }

    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  },
);
