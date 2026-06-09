// /app/src/pages/api/admin/seed-tax-zips.ts
//
// Bulk-loads zip codes for a state into a tax district.
// POST { districtId: 1, records: [{ zip, state_id }, ...] }
// Frontend parses the CSV and sends the filtered records.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { districtId, zips } = req.body as {
    districtId: number;
    zips: string[];
  };

  if (!districtId || !Array.isArray(zips) || zips.length === 0) {
    return res.status(400).json({ error: "districtId and zips array are required" });
  }

  try {
    const district = await prisma.taxDistrict.findUnique({ where: { id: districtId } });
    if (!district) return res.status(404).json({ error: "Tax district not found" });

    // Batch insert, skipping duplicates
    let created = 0;
    let skipped = 0;
    const BATCH = 200;

    for (let i = 0; i < zips.length; i += BATCH) {
      const batch = zips.slice(i, i + BATCH).filter((z) => z.trim());
      const results = await Promise.allSettled(
        batch.map((zip) =>
          prisma.taxDistrictZipCode.create({
            data: { zipCode: zip.trim(), districtId },
          }),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") created++;
        else skipped++;
      }
    }

    return res.status(200).json({
      message: `${created} zip codes added to ${district.shortName}, ${skipped} skipped`,
      created,
      skipped,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to seed zip codes";
    logError("Seed tax zips error", error);
    return res.status(500).json({ error: message });
  }
});

export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } },
};
