// /app/src/pages/api/pricing/styles/[id]/image.ts
//
// POST — Upload a replacement image for a VendorStyle.
// Saves to /data/uploads/line-drawings/{vendor-slug}/ and updates imageUrl.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";
import { createSecureForm } from "@/lib/secureUpload";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid style ID" });

  const style = await prisma.vendorStyle.findUnique({
    where: { id },
    include: { vendor: { select: { name: true } } },
  });
  if (!style) return res.status(404).json({ error: "Style not found" });

  if (req.method === "POST") {
    return handleUpload(req, res, id, style);
  }

  if (req.method === "DELETE") {
    return handleDelete(res, id, style);
  }

  res.setHeader("Allow", ["POST", "DELETE"]);
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleUpload(
  req: NextApiRequest,
  res: NextApiResponse,
  id: number,
  style: { styleNumber: string; vendor: { name: string } },
) {
  try {
    // createSecureForm("IMAGE") enforces extension + mime allowlist and
    // confines uploads to data/uploads/images/. We then move the file to
    // the per-vendor line-drawings folder below.
    const form = createSecureForm("IMAGE");
    const [, files] = await form.parse(req);

    const fileArray = files.file;
    if (!fileArray || fileArray.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadedFile = fileArray[0];
    const ext = path.extname(uploadedFile.originalFilename || "").toLowerCase() || ".jpg";

    // vendor.name comes from the DB and styleNumber is DB-controlled too,
    // but both flow through safePathJoin as defense in depth -- if a
    // malicious vendor name or style number ever lands in the DB (import
    // bug, future UI admin), the resolved path still cannot escape the
    // uploads root.
    const vendorSlug = style.vendor.name.toLowerCase().replace(/\s+/g, "-");
    const uploadsRoot = path.join(process.cwd(), "data", "uploads", "line-drawings");
    let outputDir: string;
    let destPath: string;
    try {
      outputDir = safePathJoin(uploadsRoot, vendorSlug);
      destPath = safePathJoin(outputDir, `${style.styleNumber}${ext}`);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return res.status(400).json({ error: "Invalid destination path" });
      }
      throw err;
    }
    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = path.basename(destPath);

    fs.copyFileSync(uploadedFile.filepath, destPath);
    fs.unlinkSync(uploadedFile.filepath);

    const imageUrl = `/uploads/line-drawings/${vendorSlug}/${fileName}`;

    await prisma.vendorStyle.update({
      where: { id },
      data: { imageUrl },
    });

    await prisma.product.updateMany({
      where: { vendorStyleId: id },
      data: { imageUrl },
    });

    return res.json({ imageUrl });
  } catch (error: unknown) {
    logError("Style image upload error", error);
    return res.status(500).json({
      error: "Image upload failed",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}

async function handleDelete(
  res: NextApiResponse,
  id: number,
  style: { imageUrl: string | null; styleNumber: string; vendor: { name: string } },
) {
  try {
    if (style.imageUrl) {
      // Remove file from disk if it's a local upload. imageUrl comes
      // from our own DB but we still guard with safePathJoin in case a
      // future import writes `../../...` into the field.
      const dataRoot = path.join(process.cwd(), "data");
      try {
        const localPath = safePathJoin(dataRoot, style.imageUrl);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch (err) {
        if (!(err instanceof PathTraversalError)) throw err;
        // Silently skip a traversal attempt rather than fail the DB
        // update -- still clear the DB column below.
      }
    }

    await prisma.vendorStyle.update({
      where: { id },
      data: { imageUrl: null },
    });

    await prisma.product.updateMany({
      where: { vendorStyleId: id },
      data: { imageUrl: null },
    });

    return res.json({ imageUrl: null });
  } catch (error: unknown) {
    logError("Style image delete error", error);
    return res.status(500).json({
      error: "Image removal failed",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}
