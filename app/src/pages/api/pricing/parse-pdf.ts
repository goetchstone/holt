// /app/src/pages/api/pricing/parse-pdf.ts
//
// Accepts a price-book PDF upload and returns parsed rows for client-side
// preview before import. The vendor/type dispatch lives in
// lib/pricing/parsePriceBook.ts; this file is upload, call, status.
//
// Status codes carry the meaning the UI acts on:
//   200  rows to preview (warnings may ride along as `diagnostics`)
//   400  the request cannot be parsed at all: no file, unknown vendor, a book
//        type this vendor's reader does not handle
//   422  the file was read and produced nothing usable, or failed the vendor's
//        edition check -- `diagnostics` says why. This used to be a 200 with
//        `count: 0`, which the UI showed as success (CLAUDE.md, rule 63:
//        unconfigured must fail closed, not guess).
//   500  the reader threw

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import fs from "fs";
import { createSecureForm } from "@/lib/secureUpload";
import {
  parsePriceBook,
  parseIsRefused,
  UnsupportedTypeError,
  UnsupportedVendorError,
} from "@/lib/pricing/parsePriceBook";
import { getErrorMessage } from "@/lib/toastError";

// Disable Next.js body parsing so formidable can handle the multipart upload
export const config = {
  api: { bodyParser: false },
};

function field(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let tempPath: string | null = null;
  try {
    const form = createSecureForm("PDF");
    const [fields, files] = await form.parse(req);

    const fileArray = files.file;
    if (!fileArray || fileArray.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    tempPath = fileArray[0].filepath;
    const buffer = fs.readFileSync(tempPath);

    // No default vendor. The old default was "wesley-hall", which meant an
    // unknown vendor was parsed with Wesley Hall's row shapes and reported 0.
    const vendor = field(fields.vendor).trim();
    const type = field(fields.type).trim() || "wholesale";

    const parsed = await parsePriceBook(buffer, vendor, type);

    if (parseIsRefused(parsed)) {
      return res.status(422).json({ success: false, ...parsed });
    }
    return res.status(200).json({ success: true, ...parsed });
  } catch (error: unknown) {
    if (error instanceof UnsupportedVendorError) {
      return res.status(400).json({ error: error.message, supported: error.supported });
    }
    if (error instanceof UnsupportedTypeError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({
      error: "Failed to parse PDF",
      details: getErrorMessage(error, "Internal server error"),
    });
  } finally {
    // The upload is a temp file either way; a refused parse must not leak it.
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* already gone */
      }
    }
  }
}

export default requirePermission("catalog.pricing", handler);
