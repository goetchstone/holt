// /app/src/pages/api/vendors/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client"; // Import Prisma for SortOrder
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    try {
      const fetchAll = req.query.all === "true";
      const withPricing = req.query.withPricing === "true";

      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const searchFilter = buildSearchFilter(search, ["name", "email", "phone", "city"]);
      const where: Prisma.VendorWhereInput = (searchFilter ?? {}) as Prisma.VendorWhereInput;

      if (withPricing) {
        where.priceLists = { some: {} };
      }

      const findManyArgs: Prisma.VendorFindManyArgs = {
        // Add type annotation
        where,
        orderBy: { name: Prisma.SortOrder.asc }, // Use Prisma.SortOrder.asc
      };

      // Apply skip and take only if not fetching all
      if (!fetchAll) {
        findManyArgs.skip = skip;
        findManyArgs.take = limit;
      }

      const [vendors, total] = await Promise.all([
        prisma.vendor.findMany(findManyArgs), // Use findManyArgs
        prisma.vendor.count({ where }),
      ]);

      return res.status(200).json({ vendors, total });
    } catch (error) {
      logError("Error fetching vendors", error);
      return res.status(500).json({ error: "Failed to fetch vendors" });
    }
  }

  if (req.method === "POST") {
    const { name } = req.body;

    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ error: "Vendor name is required" });
    }

    try {
      const vendor = await prisma.vendor.create({
        data: { name: name.trim() },
      });
      return res.status(201).json(vendor);
    } catch (error) {
      logError("Error creating vendor", error);
      return res.status(500).json({ error: "Failed to create vendor" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
