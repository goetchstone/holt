// /app/src/pages/api/cms/media/index.ts
//
// CMS media. GET lists uploaded assets; POST accepts a raster image upload
// (multipart) and records a MediaAsset. ADMIN-gated. Files land under
// data/uploads/images and are served at /uploads/images/<name> via
// /api/uploads/[...path]. SVG is intentionally NOT accepted here (XSS risk in
// user uploads) -- SVG logos can still be set by URL in the branding fields.

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { createSecureForm, assertUploadedFileInRoot } from "@/lib/secureUpload";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

// formidable parses the body; disable Next's parser.
export const config = { api: { bodyParser: false } };

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const media = await prisma.mediaAsset.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: { created: "desc" },
        take: 200,
      });
      return res.json({ media });
    }

    if (req.method === "POST") {
      const form = createSecureForm("IMAGE");
      form.parse(req, async (err, _fields, files) => {
        if (err) {
          logError("CMS media upload parse failed", err);
          return res.status(400).json({ error: getErrorMessage(err, "Upload failed") });
        }
        const file = Array.isArray(files.file) ? files.file[0] : files.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });
        try {
          assertUploadedFileInRoot(file);
          const url = `/uploads/images/${path.basename(file.filepath)}`;
          const asset = await prisma.mediaAsset.create({
            data: {
              organizationId: DEFAULT_ORG_ID,
              url,
              filename: file.originalFilename ?? path.basename(file.filepath),
              mimeType: file.mimetype ?? "application/octet-stream",
              bytes: file.size ?? null,
              createdBy: session.user?.email ?? null,
            },
          });
          return res.status(201).json({ asset });
        } catch (saveErr: unknown) {
          logError("CMS media save failed", saveErr);
          return res.status(400).json({ error: getErrorMessage(saveErr, "Upload failed") });
        }
      });
      return;
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
