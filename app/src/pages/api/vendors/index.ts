// /app/src/pages/api/vendors/index.ts
//
// GET lists vendors; a search also finds a vendor by a name it went by before
// another was merged into it (GAP-22). POST adds one, refusing a name a vendor
// or an earlier name already has, ignoring case: imports would find the
// existing vendor by it (lib/vendors/vendorByName.ts), so a second vendor
// under it would be the duplicate a merge cleans up.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client"; // Import Prisma for SortOrder
import { requirePermission } from "@/lib/auth/requireAuth";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";
import { findVendorByName } from "@/lib/vendors/vendorByName";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    try {
      const fetchAll = req.query.all === "true";
      const withPricing = req.query.withPricing === "true";

      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const searchFilter = buildSearchFilter(search, [
        "name",
        "email",
        "phone",
        "city",
        "aliases.some.name",
      ]);
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

  if (req.method === "POST") return handlePost(req, res);

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("catalog.write", handler);

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { name } = req.body;

  if (!name || typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "Vendor name is required" });
  }

  try {
    const existing = await findVendorByName(prisma, name.trim(), { ignoreCase: true });
    if (existing) {
      return res.status(409).json({
        error: existing.alias
          ? `${existing.alias} was merged into ${existing.name}. Use ${existing.name}.`
          : `A vendor named ${existing.name} already exists.`,
      });
    }
    const vendor = await prisma.vendor.create({
      data: { name: name.trim() },
    });
    return res.status(201).json(vendor);
  } catch (error) {
    if (getErrorCode(error) === "P2002") {
      return res.status(409).json({ error: "A vendor with that name or code already exists." });
    }
    logError("Error creating vendor", error);
    return res.status(500).json({ error: "Failed to create vendor" });
  }
}
