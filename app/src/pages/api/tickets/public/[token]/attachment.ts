// /app/src/pages/api/tickets/public/[token]/attachment.ts
//
// POST — the customer adds a file to their own ticket from the public
// status page. The publicToken IS the authorization (same capability the
// status/reply endpoint uses). Rate-limited; same hardened upload preset
// as the staff side. uploadedBy records the ticket's submitter name.

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import { rateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/prisma";
import { createSecureForm, assertUploadedFileInRoot } from "@/lib/secureUpload";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: false } };

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const token = String(req.query.token ?? "");
  if (!token) return res.status(400).json({ error: "Missing token" });

  const ticket = await prisma.ticket.findUnique({
    where: { publicToken: token },
    select: {
      id: true,
      submitterName: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const form = createSecureForm("TICKET_ATTACHMENT");
  form.parse(req, async (err, _fields, files) => {
    if (err) {
      logError("Public ticket attachment parse failed", err);
      return res.status(400).json({ error: getErrorMessage(err, "Upload failed") });
    }
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    try {
      assertUploadedFileInRoot(file);
      const uploadedBy =
        ticket.submitterName ||
        [ticket.customer?.firstName, ticket.customer?.lastName].filter(Boolean).join(" ") ||
        "Customer";
      const attachment = await prisma.ticketAttachment.create({
        data: {
          ticketId: ticket.id,
          url: `/uploads/attachments/${path.basename(file.filepath)}`,
          filename: file.originalFilename ?? path.basename(file.filepath),
          mimeType: file.mimetype ?? "application/octet-stream",
          bytes: file.size ?? null,
          uploadedBy,
        },
      });
      return res.status(201).json({
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          url: attachment.url,
        },
      });
    } catch (saveErr: unknown) {
      logError("Public ticket attachment save failed", saveErr);
      return res.status(400).json({ error: getErrorMessage(saveErr, "Upload failed") });
    }
  });
}

export default rateLimit({ windowMs: 60_000, maxRequests: 5 })(handler);
