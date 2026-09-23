// /app/src/pages/api/uploads/[...path].ts
//
// Serves user-uploaded files (inventory photos, line drawings, ticket
// attachments, and — for signed-in staff — imports, vendor price PDFs,
// delivery-proof signatures, proposals) from the /data/uploads volume. Files
// live outside public/ to avoid Next.js scanning the Docker volume on startup
// (which fails on Synology due to user-namespace remapping permissions).
//
// A rewrite in next.config.js sends /uploads/* here so existing imageUrl values
// stored in the database continue to resolve.
//
// Access: this used to serve the ENTIRE upload root to anyone, protected only by
// a 48-bit random filename. Now only the product/CMS imagery the storefront
// renders — and the ticket attachments the customer portal links to by their
// unguessable name — is served unauthenticated. Everything else requires a
// session, and the default for an unrecognised subdir is private.

import type { NextApiRequest, NextApiResponse } from "next";
import path from "path";
import fs from "fs";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

const UPLOADS_ROOT = path.join(process.cwd(), "data", "uploads");

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ppm": "image/x-portable-pixmap",
};
// `.svg` is deliberately absent. An SVG served as an inline `svg+xml` document
// from our own origin — under a CSP that still allows 'unsafe-inline' — is a stored-XSS
// vector one preset edit away. SVGs (and any unknown type) fall through to
// application/octet-stream + Content-Disposition: attachment below, so a browser
// downloads them instead of executing their script.

// Subdirs served to unauthenticated viewers by design: product/CMS imagery the
// storefront renders, and ticket attachments the customer portal links to by
// their unguessable filename (the portal authenticates the TICKET, not each
// file URL; gating attachments on a staff session would 404 a customer's own
// files — a token-authed portal file route is the proper fix and is tracked
// separately). Everything else — imports, vendor PDFs, delivery-proof,
// proposals, and any subdir not listed — requires a session. Default private: a
// new upload kind is gated until it is explicitly opted in here.
const PUBLIC_UPLOAD_SUBDIRS = new Set(["images", "inventory", "line-drawings", "attachments"]);

/** Whether the first path segment is a subdir served without authentication. */
export function isPublicUpload(segments: readonly string[]): boolean {
  return segments.length > 0 && PUBLIC_UPLOAD_SUBDIRS.has(segments[0]);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const segments = req.query.path;
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "Missing file path" });
  }

  const isPublic = isPublicUpload(segments);

  // Private subdir: require a signed-in session. Answer an unauthenticated
  // request with 404, not 403 — the endpoint must not confirm that a given file
  // exists to someone who may not read it.
  if (!isPublic) {
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(404).json({ error: "File not found" });
    }
  }

  // safePathJoin handles "..", "/..", NUL bytes, absolute-path re-root, and
  // verifies the resolved path stays under UPLOADS_ROOT.
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
  if (contentType === "application/octet-stream") {
    // Unknown or SVG: never render inline from our origin — force a download.
    res.setHeader("Content-Disposition", "attachment");
  }
  // Private files must not be cached by shared proxies; public imagery keeps its
  // long immutable cache.
  res.setHeader(
    "Cache-Control",
    isPublic ? "public, max-age=86400, immutable" : "private, no-store, max-age=0",
  );

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}
