// /app/src/lib/safePathJoin.ts
//
// Defense-in-depth path join. Resolves a set of untrusted segments against
// a trusted root directory and asserts that the resulting absolute path
// stays under that root. Throws on escape, so the API handler doesn't
// have to remember to check a boolean.
//
// Motivated by the Semgrep scan on 2026-04-24 that flagged the image-
// serving and PDF-building endpoints. All of those endpoints are behind
// authentication, so a working attack requires an authenticated staff
// member in any case; this is still worth doing to get defense in depth
// right at the file-system boundary.

import path from "path";

export class PathTraversalError extends Error {
  constructor(message = "Path escapes the allowed root") {
    super(message);
    this.name = "PathTraversalError";
  }
}

// Rejects segments that contain ".." or NUL bytes BEFORE any path math
// runs. Catches the obvious cases early with a clear error.
function rejectObviousBadSegments(segments: Array<string | undefined>) {
  for (const s of segments) {
    if (s == null) continue;
    if (s.includes("\0")) throw new PathTraversalError("NUL byte in path segment");
    // Rejecting `..` as a full segment is the highest-signal check. We
    // intentionally allow ".." as a substring of a filename like "a..b".
    if (s === ".." || s.startsWith("../") || s.endsWith("/..") || s.includes("/../")) {
      throw new PathTraversalError("Path segment contains '..'");
    }
    if (s.includes("\\..\\") || s === "..\\" || s.endsWith("\\..") || s.startsWith("..\\")) {
      throw new PathTraversalError("Path segment contains '..' (Windows)");
    }
  }
}

// Resolve `segments` under `root` and assert the result is inside `root`.
// Returns the absolute resolved path. Throws PathTraversalError on escape.
export function safePathJoin(root: string, ...segments: Array<string | undefined>): string {
  rejectObviousBadSegments(segments);
  const cleanSegments = segments.filter((s): s is string => typeof s === "string" && s.length > 0);
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, ...cleanSegments);
  if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) {
    throw new PathTraversalError();
  }
  return resolved;
}
