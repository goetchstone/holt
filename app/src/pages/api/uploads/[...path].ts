// /app/src/pages/api/uploads/[...path].ts
//
// Serves user-uploaded files (inventory photos, line drawings) from the
// /data/uploads volume. Files live outside public/ to avoid Next.js scanning
// the Docker volume on startup (which fails on Synology due to user namespace
// remapping permissions).
//
// A rewrite in next.config.js sends /uploads/* here so existing imageUrl
// values stored in the database continue to resolve.

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

const UPLOADS_ROOT = path.join(process.cwd(), "data", "uploads");

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ppm": "image/x-portable-pixmap",
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const segments = req.query.path;
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "Missing file path" });
  }

  // safePathJoin handles "..", "/..", NUL bytes, absolute-path re-root,
  // and verifies the resolved path stays under UPLOADS_ROOT.
  let filePath: string;
  try {
    filePath = safePathJoin(UPLOADS_ROOT, ...segments);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return res.status(400).json({ error: "Invalid path" });
    }
    throw err;
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return res.status(404).json({ error: "File not found" });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}
