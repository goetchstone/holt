// /app/src/pages/api/proposals/[id]/line-items/[lineId]/images/index.ts
//
// POST: Upload an image for a proposal line item.
// Saves to data/uploads/proposals/{proposalId}/{lineId}-{timestamp}.{ext}

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import fs from "fs";
import path from "path";
import { createSecureForm } from "@/lib/secureUpload";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

export const config = {
  api: { bodyParser: false },
};

// Allowlist is enforced by createSecureForm("IMAGE"); kept locally only
// for filename-extension selection below.
const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".webp"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const role = (session as any).role as string;
  if (role !== "ADMIN" && role !== "MANAGER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "POST") return handleUpload(req, res);

  res.setHeader("Allow", ["POST"]);
  return res.status(405).end();
}

async function handleUpload(req: NextApiRequest, res: NextApiResponse) {
  const proposalId = Number.parseInt(req.query.id as string, 10);
  const lineId = Number.parseInt(req.query.lineId as string, 10);
  if (Number.isNaN(proposalId) || Number.isNaN(lineId)) {
    return res.status(400).json({ error: "Invalid proposal or line item ID" });
  }

  try {
    const lineItem = await prisma.proposalLineItem.findFirst({
      where: { id: lineId, proposalId },
      select: { id: true },
    });
    if (!lineItem) return res.status(404).json({ error: "Line item not found" });

    const form = createSecureForm("IMAGE");
    const [fields, files] = await form.parse(req);

    const fileArray = files.file;
    if (!fileArray || fileArray.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadedFile = fileArray[0];
    const ext = path.extname(uploadedFile.originalFilename || "").toLowerCase() || ".jpg";
    if (!ALLOWED_EXTS.includes(ext)) {
      return res
        .status(400)
        .json({ error: `File type ${ext} not allowed. Use JPG, PNG, or WebP.` });
    }

    // proposalId is already validated as a number via parseInt at the
    // handler entry; safePathJoin is belt-and-suspenders.
    const proposalsRoot = path.join(process.cwd(), "data", "uploads", "proposals");
    const filename = `${lineId}-${Date.now()}${ext}`;
    let dir: string;
    let destPath: string;
    try {
      dir = safePathJoin(proposalsRoot, String(proposalId));
      destPath = safePathJoin(dir, filename);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return res.status(400).json({ error: "Invalid destination path" });
      }
      throw err;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(uploadedFile.filepath, destPath);
    fs.unlinkSync(uploadedFile.filepath);

    const imageUrl = `/uploads/proposals/${proposalId}/${filename}`;
    const caption = typeof fields.caption?.[0] === "string" ? fields.caption[0] : null;

    const existingCount = await prisma.proposalItemImage.count({ where: { lineItemId: lineId } });

    const image = await prisma.proposalItemImage.create({
      data: {
        lineItemId: lineId,
        imageUrl,
        caption,
        sortOrder: existingCount,
        isPrimary: existingCount === 0,
      },
    });

    return res.status(201).json(image);
  } catch (err: unknown) {
    logError("Failed to upload proposal image", err);
    return res.status(500).json({ error: "Failed to upload image" });
  }
}
