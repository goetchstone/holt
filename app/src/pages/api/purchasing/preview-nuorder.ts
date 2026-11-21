// /app/src/pages/api/purchasing/preview-nuorder.ts
//
// Preview endpoint for NuORDER PDFs. Parses the PDF and returns the
// extracted data without creating any records. Used by the import page
// to show a preview before the user confirms department/category selections.

import type { NextApiRequest, NextApiResponse } from "next";
import { logError } from "@/lib/logger";
import { requirePermission } from "@/lib/auth/requireAuth";
import { parseNuOrderPDF } from "@/lib/pricing/nuorderParser";
import fs from "fs";
import {
  createSecureForm,
  noFileMessage,
  uploadRefusal,
  type UploadPresetName,
} from "@/lib/secureUpload";

export const config = { api: { bodyParser: false } };

const UPLOAD: UploadPresetName = "PDF";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const form = createSecureForm(UPLOAD);
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: noFileMessage(UPLOAD) });

    const buffer = fs.readFileSync(file.filepath);
    const parsed = await parseNuOrderPDF(buffer);

    if (!parsed.items.length) {
      // A line cut short can be why no item was found; the page lists the warnings.
      return res
        .status(400)
        .json({ error: "No line items found in PDF", warnings: parsed.warnings });
    }

    return res.status(200).json(parsed);
  } catch (error: unknown) {
    const refused = uploadRefusal(error, UPLOAD);
    if (refused) return res.status(refused.status).json({ error: refused.error });
    logError("NuORDER preview: parse failed", error);
    return res.status(500).json({ error: "Parse failed" });
  }
}

export default requirePermission("purchasing.receive", handler);
