// /app/src/pages/api/tickets/[id]/attachments.ts
//
// POST — staff upload a file attachment to a ticket (multipart). Same role
// gate as ticket replies. Files land under data/uploads/attachments with
// random names (createSecureForm) and serve via /api/uploads/[...path].

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { createSecureForm, assertUploadedFileInRoot } from "@/lib/secureUpload";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: false } };

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }
    const ticketId = Number.parseInt(String(req.query.id), 10);
    if (Number.isNaN(ticketId)) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    const form = createSecureForm("TICKET_ATTACHMENT");
    form.parse(req, async (err, _fields, files) => {
      if (err) {
        logError("Ticket attachment upload parse failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Upload failed") });
      }
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });
      try {
        assertUploadedFileInRoot(file);
        const attachment = await prisma.ticketAttachment.create({
          data: {
            ticketId,
            url: `/uploads/attachments/${path.basename(file.filepath)}`,
            filename: file.originalFilename ?? path.basename(file.filepath),
            mimeType: file.mimetype ?? "application/octet-stream",
            bytes: file.size ?? null,
            uploadedBy: session.user?.email ?? null,
          },
        });
        return res.status(201).json({ attachment });
      } catch (saveErr: unknown) {
        logError("Ticket attachment save failed", saveErr);
        return res.status(400).json({ error: getErrorMessage(saveErr, "Upload failed") });
      }
    });
  },
);
