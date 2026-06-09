// /app/src/pages/api/purchasing/preview-nuorder.ts
//
// Preview endpoint for NuORDER PDFs. Parses the PDF and returns the
// extracted data without creating any records. Used by the import page
// to show a preview before the user confirms department/category selections.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { parseNuOrderPDF } from "@/lib/pricing/nuorderParser";
import fs from "fs";
import { createSecureForm } from "@/lib/secureUpload";
import { getErrorMessage } from "@/lib/toastError";

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const form = createSecureForm("PDF");
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const buffer = fs.readFileSync(file.filepath);
    const parsed = await parseNuOrderPDF(buffer);

    if (!parsed.items.length) {
      return res.status(400).json({ error: "No line items found in PDF" });
    }

    return res.status(200).json(parsed);
  } catch (error: unknown) {
    return res.status(500).json({ error: getErrorMessage(error, "Parse failed") });
  }
}
