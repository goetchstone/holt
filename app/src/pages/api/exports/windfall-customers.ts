// /app/src/pages/api/exports/windfall-customers.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { AsyncParser } from "@json2csv/node";
import { logger, logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        created: true,
        externalIds: {
          take: 1,
          orderBy: { created: "desc" },
          select: { externalId: true },
        },
        addresses: {
          take: 1,
          orderBy: { created: "desc" },
          select: {
            address1: true,
            address2: true,
            city: true,
            state: true,
            zip: true,
          },
        },
        salesOrders: {
          take: 1,
          orderBy: { orderDate: "desc" },
          select: { storeLocation: true },
        },
      },
    });

    const rows: Record<string, unknown>[] = [];

    for (const c of customers) {
      const addr = c.addresses[0];
      const cuscode = c.externalIds[0]?.externalId || "";
      const company = c.salesOrders[0]?.storeLocation || "";
      const address1 = addr?.address1 || "";
      const address2 = addr?.address2 || "";
      const fullAddress = address2 ? `${address1}, ${address2}` : address1;

      rows.push({
        Company: company,
        Cuscode: cuscode,
        CreatedDate: c.created ? c.created.toISOString().slice(0, 10) : "",
        FirstName: c.firstName || "",
        LastName: c.lastName || "",
        Email: c.email || "",
        Address: fullAddress,
        City: addr?.city || "",
        State: addr?.state || "",
        Zip: addr?.zip || "",
        Phone: c.phone || "",
      });
    }

    const fields = [
      "Company",
      "Cuscode",
      "CreatedDate",
      "FirstName",
      "LastName",
      "Email",
      "Address",
      "City",
      "State",
      "Zip",
      "Phone",
    ];

    const parser = new AsyncParser({ fields });
    const csv = await parser.parse(rows).promise();

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
    const filename = `${today}_holt_customers.csv`;

    logger.info(`Windfall customer export: ${rows.length} customers`);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err: unknown) {
    logError("Windfall customer export failed", err);
    return res.status(500).json({ error: "Export failed" });
  }
}
