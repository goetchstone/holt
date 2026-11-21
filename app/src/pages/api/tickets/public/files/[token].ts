// /app/src/pages/api/tickets/public/files/[token].ts
//
// GET -- a customer opens one file on their own ticket, from the no-login status
// page (/support/[token]). The token is a signed, one-hour capability for ONE
// attachment (lib/tickets/attachmentToken.ts), minted by the public status GET
// each time the page loads; it is the only credential. The raw
// /uploads/attachments path is staff-only ("View service", UPLOAD_READ_ACCESS in
// lib/secureUpload.ts), so the customer's way in is this route.
//
// 404 for anything else: the helpdesk module off, a token that is expired,
// forged or of another family, an attachment that is gone, or a row whose file
// is not in the ticket-attachment directory -- a token can only ever serve a
// file from there. Rate-limited like the ticket's other public routes.
//
// The static `files` segment takes precedence over the sibling dynamic
// public/[token] route, and a ticket's publicToken (32 base64url characters) is
// never "files".

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { PathTraversalError, safePathJoin } from "@/lib/safePathJoin";
import { sendUploadedFile, UPLOAD_PRESETS, UPLOAD_ROOT } from "@/lib/secureUpload";
import { verifyTicketAttachmentToken } from "@/lib/tickets/attachmentToken";

const SUBDIR = UPLOAD_PRESETS.TICKET_ATTACHMENT.subdir;

export default rateLimit(
  { windowMs: 60_000, maxRequests: 30 },
  "ticket-attachment-file",
)(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  if (!(await isModuleEnabled("helpdesk"))) {
    return res.status(404).json({ error: "Not found" });
  }

  const claims = verifyTicketAttachmentToken(String(req.query.token ?? ""));
  if (!claims) {
    return res.status(404).json({
      error:
        "This file link has expired or is not valid. Reload your request page for a fresh one.",
    });
  }

  const attachment = await prisma.ticketAttachment.findUnique({
    where: { id: claims.attachmentId },
    select: { url: true },
  });
  const name = attachment?.url.startsWith(`/uploads/${SUBDIR}/`)
    ? path.posix.basename(attachment.url)
    : null;
  if (!name) return res.status(404).json({ error: "File not found" });

  // The stored name is joined under the ticket-attachment directory itself,
  // never the stored path, so nothing in the row can point elsewhere.
  let filePath: string;
  try {
    filePath = safePathJoin(UPLOAD_ROOT, SUBDIR, name);
  } catch (err) {
    if (err instanceof PathTraversalError) return res.status(404).json({ error: "File not found" });
    throw err;
  }
  return sendUploadedFile(res, filePath, { cache: "private", downloadName: name });
});
