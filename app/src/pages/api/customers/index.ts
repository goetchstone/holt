// /app/src/pages/api/customers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { buildSearchFilter } from "@/lib/buildSearchFilter";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userEmail = session.user.email;

  if (req.method === "GET") {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const searchTerm = (req.query.search as string) || "";
    const sortBy = (req.query.sortBy as string) || "lastName";
    const sortDirection = (req.query.sortDirection as string) || "asc";

    const skip = (page - 1) * limit;

    try {
      // Multi-token search: "John Smith" matches firstName=John AND lastName=Smith.
      const searchFilter = buildSearchFilter(searchTerm, [
        "firstName",
        "lastName",
        "email",
        "phone",
        "externalIds.some.externalId",
      ]);
      const whereClause: Prisma.CustomerWhereInput = (searchFilter ??
        {}) as Prisma.CustomerWhereInput;

      const customers = await prisma.customer.findMany({
        skip,
        take: limit,
        where: whereClause,
        include: {
          addresses: true,
          externalIds: true,
        },
        orderBy: {
          [sortBy]: sortDirection,
        },
      });

      const totalCustomers = await prisma.customer.count({ where: whereClause });

      return res.status(200).json({
        data: customers,
        totalPages: Math.ceil(totalCustomers / limit),
      });
    } catch (error) {
      return res.status(500).json({ error: "Failed to fetch customers" });
    }
  } else if (req.method === "POST") {
    try {
      const customer = await prisma.customer.create({
        data: {
          ...req.body,
          createdBy: userEmail,
        },
      });
      return res.status(201).json(customer);
    } catch (error) {
      return res.status(500).json({ error: "Failed to create customer" });
    }
  } else {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
