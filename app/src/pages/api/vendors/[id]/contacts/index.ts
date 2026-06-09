// /app/src/pages/api/vendors/[id]/contacts/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Vendor contacts are buyer/purchasing/manager data. Writes gated to
// the staff who maintain vendor relationships. GETs are wrapped under
// the same role set since contact details (direct emails/phones) are
// sensitive enough that register / marketing / installer don't need
// API-level access.
export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    const vendorId = Number.parseInt(req.query.id as string);
    if (Number.isNaN(vendorId)) {
      return res.status(400).json({ error: "Invalid vendor ID" });
    }

    if (req.method === "POST") {
      const { name, email, phone, role } = req.body;

      if (!name || !email) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      try {
        const contact = await prisma.vendorContact.create({
          data: {
            vendorId,
            name: name.trim(),
            email: email.trim(),
            phone: phone?.trim(),
            role: role?.trim(),
          },
        });

        return res.status(201).json(contact);
      } catch (err) {
        logError("Failed to add vendor contact", err, { vendorId });
        return res.status(500).json({ error: "Failed to add contact" });
      }
    }

    if (req.method === "GET") {
      try {
        const contacts = await prisma.vendorContact.findMany({
          where: { vendorId },
          orderBy: { name: "asc" },
        });
        return res.status(200).json(contacts);
      } catch (err) {
        logError("Failed to load vendor contacts", err, { vendorId });
        return res.status(500).json({ error: "Failed to load contacts" });
      }
    }

    if (req.method === "DELETE") {
      const contactId = Number.parseInt(req.query.contactId as string);

      if (!contactId) {
        return res.status(400).json({ error: "Missing contactId" });
      }

      try {
        // IDOR guard — the contact being deleted MUST belong to the
        // vendor in the URL. Without this check, an attacker could pass
        // vendorId=X with contactId=Y from a different vendor and
        // delete anyone's contact.
        const existing = await prisma.vendorContact.findUnique({
          where: { id: contactId },
          select: { vendorId: true },
        });
        if (!existing || existing.vendorId !== vendorId) {
          return res.status(404).json({ error: "Contact not found for this vendor" });
        }
        await prisma.vendorContact.delete({
          where: { id: contactId },
        });
        return res.status(204).end();
      } catch (err) {
        logError("Failed to delete vendor contact", err, { vendorId, contactId });
        return res.status(500).json({ error: "Failed to delete contact" });
      }
    }

    res.setHeader("Allow", ["GET", "POST", "DELETE"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  },
);
