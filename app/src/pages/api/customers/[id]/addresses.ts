// /app/src/pages/api/customers/[id]/addresses.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Address management touches PII and the delivery flow -- restrict to
// staff roles that legitimately need to edit customer data. Designers
// build quotes (create/edit addresses), managers fix records, warehouse
// ships to them. Register/Installer have no business modifying addresses.
export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "MARKETING"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    const customerId = Number.parseInt(req.query.id as string);

    if (Number.isNaN(customerId)) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    // POST: Add a new address
    if (req.method === "POST") {
      const { address1, address2, city, state, zip } = req.body;
      if (!address1 || !city || !state || !zip) {
        return res.status(400).json({ error: "Missing required address fields." });
      }
      try {
        const newAddress = await prisma.customerAddress.create({
          data: { customerId, address1, address2, city, state, zip },
        });
        return res.status(201).json(newAddress);
      } catch (error) {
        logError("Add customer address failed", error, { customerId });
        return res.status(500).json({ error: "Failed to add new address." });
      }
    }

    // PUT: Update an existing address. IDOR guard -- the address being
    // updated MUST belong to the customer in the URL. Without this check
    // an attacker could pass customerId=X in the URL and addressId=Y from
    // a different customer in the body.
    if (req.method === "PUT") {
      const addressId = Number.parseInt(req.body.id);
      if (
        Number.isNaN(addressId) ||
        !req.body.address1 ||
        !req.body.city ||
        !req.body.state ||
        !req.body.zip
      ) {
        return res.status(400).json({ error: "Invalid address ID or missing fields." });
      }
      try {
        const existing = await prisma.customerAddress.findUnique({
          where: { id: addressId },
          select: { customerId: true },
        });
        if (!existing || existing.customerId !== customerId) {
          return res.status(404).json({ error: "Address not found for this customer." });
        }
        const { id: _ignore, customerId: _ignoreCid, ...safeData } = req.body;
        void _ignore;
        void _ignoreCid;
        const updatedAddress = await prisma.customerAddress.update({
          where: { id: addressId },
          data: safeData,
        });
        return res.status(200).json(updatedAddress);
      } catch (error) {
        logError("Update customer address failed", error, { customerId, addressId });
        return res.status(500).json({ error: "Failed to update address." });
      }
    }

    // DELETE: Same IDOR guard as PUT.
    if (req.method === "DELETE") {
      const addressId = Number.parseInt(req.body.id);
      if (Number.isNaN(addressId)) {
        return res.status(400).json({ error: "Invalid address ID." });
      }
      try {
        const existing = await prisma.customerAddress.findUnique({
          where: { id: addressId },
          select: { customerId: true },
        });
        if (!existing || existing.customerId !== customerId) {
          return res.status(404).json({ error: "Address not found for this customer." });
        }
        await prisma.customerAddress.delete({
          where: { id: addressId },
        });
        return res.status(204).end();
      } catch (error) {
        logError("Delete customer address failed", error, { customerId, addressId });
        return res.status(500).json({ error: "Failed to delete address." });
      }
    }

    res.setHeader("Allow", ["GET", "POST", "PUT", "DELETE"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  },
);
