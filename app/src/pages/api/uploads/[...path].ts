// /app/src/pages/api/uploads/[...path].ts
//
// Serves uploaded files from the /data/uploads volume. Files live outside
// public/ to avoid Next.js scanning the Docker volume on startup (which fails on
// Docker hosts that remap user namespaces on mounted volumes). A rewrite in
// next.config.js sends /uploads/* here, so the /uploads/... URLs stored in the
// database resolve.
//
// Who may read what is UPLOAD_READ_ACCESS in lib/secureUpload.ts, one entry per
// subdir (SEC-04b): the storefront's imagery is public, every other subdir takes
// the key of the screen that shows its files, and a subdir nobody classified is
// served to nobody. The key is decided by resolvePermissionAccess, the same
// function behind requirePermission, so a role's grants, deactivation and View
// as all count. Every refusal is a 404, never 401 or 403: the route must not
// confirm that a file exists to someone who may not read it.
//
// The request is classified by the file it RESOLVES to, not by its first raw
// segment. Next decodes each catch-all entry after splitting on "/", so
// /uploads/images/%2F<root>%2F<private subdir>%2F<name> arrives as a public first
// segment carrying an absolute path, which safePathJoin re-roots inside the root.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";
import { sendUploadedFile, uploadReadAccessFor, UPLOAD_ROOT } from "@/lib/secureUpload";
import {
  logBootstrapBypass,
  logPermissionDenial,
  resolvePermissionAccess,
  type PermissionRequirement,
} from "@/lib/auth/permissionResolver";

function notFound(res: NextApiResponse) {
  return res.status(404).json({ error: "File not found" });
}

/** Does the signed-in caller hold `permission`? Decided as requirePermission decides it. */
async function mayRead(
  req: NextApiRequest,
  res: NextApiResponse,
  permission: PermissionRequirement,
): Promise<boolean> {
  const session = await getServerSession(req, res, authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return false;
  const result = await resolvePermissionAccess({
    userId,
    permission,
    impersonate: req.cookies?.["holt-impersonate"] || null,
  });
  if (!result.allowed) {
    logPermissionDenial(userId, permission, result);
    return false;
  }
  if (result.bootstrapBypass) logBootstrapBypass(userId, permission, result);
  return true;
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

  // safePathJoin handles "..", "/..", NUL bytes, absolute-path re-root, and
  // verifies the resolved path stays under UPLOAD_ROOT.
  let filePath: string;
  try {
    filePath = safePathJoin(UPLOAD_ROOT, ...segments);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return res.status(400).json({ error: "Invalid path" });
    }
    throw err;
  }

  const access = uploadReadAccessFor(filePath);
  if (!access) return notFound(res);
  if (!access.public && !(await mayRead(req, res, access.permission))) return notFound(res);

  return sendUploadedFile(res, filePath, { cache: access.public ? "public" : "private" });
}
