// /app/src/pages/api/inventory/unidentified-scan.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import path from "path";
import fs from "fs/promises";
import { createSecureForm, assertUploadedFileInRoot } from "@/lib/secureUpload";
import { logError } from "@/lib/logger";

// Disable Next.js body parser to use formidable
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as any)?.id;

  if (!userId) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  const form = createSecureForm("INVENTORY_SCAN");

  form.parse(req, async (err, fields, files) => {
    if (err) {
      logError("Error parsing form", err);
      return res.status(500).json({ error: "Error uploading file." });
    }

    const imageFile = Array.isArray(files.image) ? files.image[0] : files.image;
    const locationArray = Array.isArray(fields.location) ? fields.location : [fields.location];
    const notesArray = Array.isArray(fields.notes) ? fields.notes : [fields.notes];

    const location = locationArray[0];
    const notes = notesArray[0];

    if (!imageFile) {
      return res.status(400).json({ error: "No image file uploaded." });
    }
    if (!location) {
      return res.status(400).json({ error: "Location is required." });
    }
    // Defense-in-depth: belt-and-suspenders path-traversal guard.
    // Closes CodeQL js/path-injection on the path.basename + fs.unlink calls below.
    assertUploadedFileInRoot(imageFile);

    // The filename from formidable is the new name of the file in the uploadDir.
    // We just need the basename for the URL.
    const imageUrl = `/uploads/inventory/${path.basename(imageFile.filepath)}`;

    try {
      const unidentifiedScan = await prisma.unidentifiedScan.create({
        data: {
          imageUrl,
          location,
          notes,
          countedByUserId: userId,
        },
      });

      return res.status(201).json(unidentifiedScan);
    } catch (dbError) {
      logError("Error saving to database", dbError);
      // Attempt to clean up the uploaded file if DB insert fails
      try {
        await fs.unlink(imageFile.filepath);
      } catch (unlinkError) {
        logError("Error cleaning up file", unlinkError);
      }
      return res.status(500).json({ error: "Failed to save scan record." });
    }
  });
}
