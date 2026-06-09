// /app/src/pages/api/customers/merge-duplicates.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    let mergedCount = 0;
    let duplicateRecordsDeleted = 0;

    const duplicateGroups = await prisma.customer.groupBy({
      by: ["firstName", "lastName"],
      _count: {
        id: true,
      },
      having: {
        id: {
          _count: {
            gt: 1,
          },
        },
      },
    });

    for (const group of duplicateGroups) {
      if (!group.firstName || !group.lastName) continue;

      const customersInGroup = await prisma.customer.findMany({
        where: {
          firstName: group.firstName,
          lastName: group.lastName,
        },
        include: {
          externalIds: true,
          addresses: true,
        },
      });

      // Designate the record with the most externalIds as the master
      customersInGroup.sort((a, b) => b.externalIds.length - a.externalIds.length);
      const masterCustomer = customersInGroup[0];
      const duplicates = customersInGroup.slice(1);

      mergedCount++;

      for (const duplicate of duplicates) {
        // Re-link the POS IDs from the duplicate to the master
        await prisma.customerExternalId.updateMany({
          where: { customerId: duplicate.id },
          data: { customerId: masterCustomer.id },
        });

        // Re-link Addresses from the duplicate to the master
        await prisma.customerAddress.updateMany({
          where: { customerId: duplicate.id },
          data: { customerId: masterCustomer.id },
        });

        // Now that relations are moved, delete the duplicate customer
        await prisma.customer.delete({
          where: { id: duplicate.id },
        });
        duplicateRecordsDeleted++;
      }
    }

    res.status(200).json({
      message: `Merge complete. ${mergedCount} groups of duplicates merged. ${duplicateRecordsDeleted} duplicate records deleted.`,
    });
  } catch (error) {
    logError("Unexpected error", error);
    res.status(500).json({ error: "Failed to merge duplicate customers." });
  }
});
