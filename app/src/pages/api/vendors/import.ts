// /app/src/pages/api/vendors/import.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { vendors } = req.body;

    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ error: "No vendor data provided" });
    }

    try {
      for (const v of vendors) {
        if (!v.name || typeof v.name !== "string") continue;

        await prisma.vendor.upsert({
          where: { name: v.name },
          update: {
            address: v.address?.trim() || undefined,
            city: v.city?.trim() || undefined,
            state: v.state?.trim() || undefined,
            zip: v.zip?.trim() || undefined,
            phone: v.phone?.trim() || undefined,
            email: v.email?.trim() || undefined,
          },
          create: {
            name: v.name.trim(),
            address: v.address?.trim() || undefined,
            city: v.city?.trim() || undefined,
            state: v.state?.trim() || undefined,
            zip: v.zip?.trim() || undefined,
            phone: v.phone?.trim() || undefined,
            email: v.email?.trim() || undefined,
          },
        });
      }

      return res.status(200).json({ message: "Vendors imported successfully" });
    } catch (err) {
      logError("Vendor import failed", err);
      return res.status(500).json({ error: "Import failed" });
    }
  },
);
