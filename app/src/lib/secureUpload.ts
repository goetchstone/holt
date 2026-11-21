// /app/src/lib/secureUpload.ts
//
// Central upload-handling factory used by every endpoint that accepts a
// multipart file. Replaces bare `formidable()` calls so we can't ship a
// handler that accepts arbitrary extensions into an arbitrary folder.
//
// Every call must pick a preset. If you need a new preset, add it here —
// never pass the options inline at the call site. That keeps the
// security posture centralised and prevents one endpoint from drifting
// relative to the others.
//
// The read side lives here too (SEC-04b): who may read each subdir
// (UPLOAD_READ_ACCESS) and how a stored file is sent (sendUploadedFile), so
// every fact about upload storage has one home.

import type { NextApiResponse } from "next";
import formidable, { type File } from "formidable";
import path from "path";
import fs from "fs";
import { randomBytes } from "node:crypto";
import type { PermissionRequirement } from "@/lib/auth/roleDecision";
import { logError } from "@/lib/logger";

// Root of every upload destination. All preset uploadDirs resolve
// beneath here, and the filter rejects any resolved path that escapes.
export const UPLOAD_ROOT = path.resolve(process.cwd(), "data", "uploads");

interface UploadPreset {
  /** Subdirectory under UPLOAD_ROOT where files will land. Auto-created. */
  subdir: string;
  /** Allowed file extensions, lower-case, with leading dot. ["*"] means any. */
  allowedExtensions: string[];
  /** Allowed mime types. formidable populates mimetype from the upload; we
   * treat mimetype + extension as BOTH-must-match for defence in depth. */
  allowedMimeTypes: string[];
  /** Max size per file, in bytes. */
  maxFileSize: number;
  /** Max files per request. Defaults to 1. */
  maxFiles?: number;
}

export const UPLOAD_PRESETS: Record<string, UploadPreset> = {
  // CSV + XLSX admin imports (sales, inventory, PO data, customers, etc.)
  CSV_XLSX: {
    subdir: "imports",
    allowedExtensions: [".csv", ".xlsx", ".xls"],
    allowedMimeTypes: [
      "text/csv",
      "application/csv",
      // Some browsers type a .csv as text/plain; it is still a CSV.
      "text/plain",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      // Some browsers send octet-stream (the generic "unknown") for XLSX/CSV;
      // accepted here because the extension gate carries the intent. A wrong,
      // SPECIFIC type (image/png, application/x-msdownload) is still refused.
      "application/octet-stream",
    ],
    maxFileSize: 50 * 1024 * 1024, // 50MB — some sales CSVs run large
  },
  // Vendor price-list PDFs.
  PDF: {
    subdir: "pdfs",
    allowedExtensions: [".pdf"],
    allowedMimeTypes: ["application/pdf"],
    maxFileSize: 30 * 1024 * 1024,
  },
  // Product / proposal / scan images.
  IMAGE: {
    subdir: "images",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".heic"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    maxFileSize: 10 * 1024 * 1024,
  },
  // Warehouse "unidentified item" photo scans. Kept under its own root
  // to match the existing /uploads/inventory/ URL prefix.
  INVENTORY_SCAN: {
    subdir: "inventory",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".heic"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    maxFileSize: 15 * 1024 * 1024,
  },
  // Helpdesk ticket attachments: screenshots + PDFs from customers and
  // staff. No SVG (XSS) and no archives/executables by construction.
  TICKET_ATTACHMENT: {
    subdir: "attachments",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf"],
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "application/pdf",
    ],
    maxFileSize: 10 * 1024 * 1024,
  },
  // Delivery proof — can be either an image (photo) or the signature
  // blob (which is usually captured as PNG on-device).
  DELIVERY_PROOF: {
    subdir: "delivery-proof",
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".heic"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
    maxFileSize: 15 * 1024 * 1024,
    maxFiles: 2, // signature + photo
  },
};

export type UploadPresetName =
  "CSV_XLSX" | "PDF" | "IMAGE" | "INVENTORY_SCAN" | "TICKET_ATTACHMENT" | "DELIVERY_PROOF";

export type UploadReadAccess =
  | { public: true; reason: string }
  | { public: false; permission: PermissionRequirement; reason: string };

/**
 * Who may read the files in each subdir of UPLOAD_ROOT, as served by
 * /api/uploads/[...path] (and /uploads/* through the rewrite in next.config.js).
 *
 * The rule: a subdir takes the key PAGE_ACCESS (lib/auth/pagePermissions.ts)
 * maps the screen that shows its files to. Where the screen is gated on that
 * key, granting a role the screen in Roles grants the files behind it. Where it
 * still checks a role list (a `widensFrom` entry, not applied), the files follow
 * the key and the screen the list, so they admit different roles until the
 * screen moves onto its key: ticket files and proposal pictures, each reason
 * below says how. A subdir no screen shows takes admin.data. A subdir not
 * listed here is served to nobody, signed in or not: an unclassified subdir
 * fails closed rather than guessing (CLAUDE.md rule 63). Public means no
 * session at all, so only files the storefront and emails must load are public.
 *
 * This is a rule-65 manifest: __tests__/uploadsRouteAuth.test.ts fails when a
 * preset, or a hand-built path that names its subdir as a literal (joined under
 * "data", "uploads" or UPLOAD_ROOT, or in a stored "/uploads/<subdir>/" URL),
 * writes a subdir missing here, or when an entry here names a subdir nothing
 * writes. A subdir held in a variable is not seen: name it as a literal.
 */
export const UPLOAD_READ_ACCESS: Readonly<Record<string, UploadReadAccess>> = {
  images: {
    public: true,
    reason:
      "CMS media and product pictures; storefront blocks and email and login logos load them with no session",
  },
  "line-drawings": { public: true, reason: "vendor catalog art printed on invoices" },
  inventory: {
    public: false,
    permission: "inventory.count",
    reason: "unidentified-item photos; only Reconcile Photos shows them",
  },
  attachments: {
    public: false,
    permission: "service.read",
    reason:
      "helpdesk ticket files for staff, on the ticket page's key in PAGE_ACCESS, not yet its gate: the page admits SUPER_ADMIN, ADMIN and MANAGER, while every holder of service.read reads the files; customers open theirs through /api/tickets/public/files/[token]",
  },
  proposals: {
    public: false,
    permission: "sales.read",
    reason:
      "proposal line pictures, on the proposal pages' key in PAGE_ACCESS, not yet their gate: the pages admit MANAGER and ADMIN, while every holder of sales.read reads the pictures",
  },
  imports: {
    public: false,
    permission: "admin.data",
    reason:
      "no screen links to these files; Destructive data operations already covers whole-data copies",
  },
  pdfs: {
    public: false,
    permission: "admin.data",
    reason:
      "no screen links to these files; Destructive data operations already covers whole-data copies",
  },
  "delivery-proof": {
    public: false,
    permission: "admin.data",
    reason:
      "no screen links to these files; Destructive data operations already covers whole-data copies",
  },
};

/**
 * Who may read the file at `filePath`: the entry for the subdir it actually
 * sits in, or null for a path outside UPLOAD_ROOT, a file at the root itself,
 * or a subdir nobody classified.
 *
 * Classified by the RESOLVED path, never by a request's first raw segment: Next
 * decodes each catch-all entry after splitting on "/", so an encoded %2F can
 * carry an absolute path inside a public-looking first segment.
 *
 * The subdir is looked up as an OWN key only: a "__proto__" or "constructor"
 * segment must not resolve to an Object.prototype member (the CodeQL
 * remote-property-injection class permissionResolver.ts guards the same way).
 */
export function uploadReadAccessFor(filePath: string): UploadReadAccess | null {
  const relative = path.relative(UPLOAD_ROOT, path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  if (path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (parts.length < 2) return null;
  const subdir = parts[0];
  return Object.hasOwn(UPLOAD_READ_ACCESS, subdir) ? UPLOAD_READ_ACCESS[subdir] : null;
}

interface CreateFormOptions {
  /** Optional override to place files in a preset's named sub-subdirectory
   * (e.g. per-style image folder). Combined under the preset root. */
  subPath?: string;
  /** Optional file-name generator. Receives the sanitized original name
   * + extension. Defaults to a timestamped random name. */
  filename?: (originalName: string | null, ext: string) => string;
}

// Reject anything that escapes UPLOAD_ROOT when resolved.
function assertInsideRoot(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep) && resolved !== UPLOAD_ROOT) {
    throw new Error(`secureUpload: path ${candidate} resolves outside UPLOAD_ROOT — refusing`);
  }
  return resolved;
}

function ensureDir(dir: string): string {
  const resolved = assertInsideRoot(dir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Build a formidable instance hardened against path traversal, arbitrary
 * extensions, and surprise file sizes. Every API route that accepts a
 * multipart upload MUST use this helper.
 */
/**
 * The upload gate as a pure predicate, so it can be tested without formidable.
 * Extension AND declared MIME must BOTH pass (UploadPreset's "both-must-match"
 * intent). A missing mimetype leaves the extension as the check. A present
 * mimetype must appear in the preset's own allow-list -- which contains
 * application/octet-stream ONLY for presets whose sources legitimately send that
 * generic type (spreadsheets/CSV), so octet-stream is accepted there and nowhere
 * else. A specific WRONG type -- an .exe renamed .xlsx and typed
 * application/x-msdownload, a script typed image/png -- is refused even when the
 * extension matched.
 *
 * Previously, because octet-stream sat in the CSV/XLSX allow-list, the "reject
 * unlisted mime" branch could never fire for that preset: EVERY declared type
 * passed and the extension was the only real gate. This restores both gates.
 */
export function isUploadAllowed(
  preset: Pick<UploadPreset, "allowedExtensions" | "allowedMimeTypes">,
  originalFilename: string | null | undefined,
  mimetype: string | null | undefined,
): boolean {
  const ext = path.extname(originalFilename ?? "").toLowerCase();
  if (!preset.allowedExtensions.includes(ext)) return false;
  if (!mimetype) return true;
  return preset.allowedMimeTypes.includes(mimetype);
}

export function createSecureForm(preset: UploadPresetName, options: CreateFormOptions = {}) {
  const p = UPLOAD_PRESETS[preset];
  const targetDir = ensureDir(path.join(UPLOAD_ROOT, p.subdir, options.subPath ?? ""));

  // SonarQube S2598 ("restrict the extension of uploaded files") flags every
  // formidable() call statically and can't follow the `filter` + `filename`
  // functions below. This usage IS hardened: the `filter` rejects any extension
  // not in the per-preset allowlist BEFORE a byte is streamed, and `filename`
  // discards the user-supplied name entirely (crypto-random name + validated
  // ext). Verified-safe; mark the S2598 issue "Safe / False Positive" in the
  // Sonar UI (the analysis token has no issue-admin to do it programmatically).
  return formidable({
    uploadDir: targetDir,
    keepExtensions: true,
    maxFileSize: p.maxFileSize,
    maxFiles: p.maxFiles ?? 1,
    multiples: (p.maxFiles ?? 1) > 1,
    // Filter runs before the file is written. Reject bad extensions +
    // bad mime types here so we never even start streaming to disk.
    filter: ({ originalFilename, mimetype }) => isUploadAllowed(p, originalFilename, mimetype),
    // Custom filename keeps the extension but replaces the original name
    // with our generator so user-controlled path components can never
    // land on disk verbatim.
    filename: (_name, ext, part) => {
      const origName = part.originalFilename ?? null;
      if (options.filename) return options.filename(origName, ext);
      // Crypto-random suffix prevents an attacker from racing or guessing
      // the on-disk path of someone else's upload before processing
      // completes. 12 hex chars = 48 bits of entropy, paired with the
      // millisecond timestamp for fast eyeballing in logs.
      const stamp = Date.now();
      const rand = randomBytes(6).toString("hex");
      return `${stamp}-${rand}${ext}`;
    },
  });
}

/**
 * Helper: after parsing, every File should still live under the preset
 * root. Callers can invoke this as a belt-and-suspenders guard before
 * acting on the file path (e.g. passing to fs.readFile).
 */
export function assertUploadedFileInRoot(file: File): void {
  assertInsideRoot(file.filepath);
}

// ---------------------------------------------------------------------------
// Sending a stored file
// ---------------------------------------------------------------------------

const OCTET_STREAM = "application/octet-stream";

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
// from our own origin is a stored-XSS vector one preset edit away. The CSP no
// longer lets an inline script run (/uploads/* gets the proxy's nonce policy,
// src/proxy.ts; /api/uploads/* the static API policy in next.config.js), and
// keeping SVG out stays as a second layer: SVGs (and any unknown type) fall
// through to application/octet-stream + Content-Disposition: attachment below,
// so a browser downloads them instead of rendering them.

/** A name safe to put inside a quoted header parameter as it stands. */
const SAFE_DOWNLOAD_NAME = /^[\w.-]+$/;

function notFound(res: NextApiResponse): void {
  res.status(404).json({ error: "File not found" });
}

/**
 * Send the stored file at `filePath`, or 404 when there is none. The caller has
 * already decided the reader may have it; this only sends it.
 *
 * `cache: "private"` keeps it out of shared caches. `downloadName`, when it is
 * a plain file name, is named in Content-Disposition: `attachment` for a type
 * we force to download, `inline` for an image.
 *
 * A stat that fails answers 404 like a missing file, whatever the reason: a
 * name the filesystem refuses (a segment past 255 bytes is ENAMETOOLONG) is no
 * file either. A read that fails after the stat (the file removed, unreadable)
 * answers 404 while nothing has been sent, and ends the response if it already
 * started, rather than leaving the client waiting: this is reachable from
 * public routes.
 *
 * A client that has gone, before the send or during it, leaves no file open.
 */
export function sendUploadedFile(
  res: NextApiResponse,
  filePath: string,
  opts: { cache: "public" | "private"; downloadName?: string },
): void {
  const resolved = assertInsideRoot(filePath);
  // A caller may wait on a session or a database read before it gets here (a
  // private subdir, a ticket file). A client that left meanwhile has a response
  // that has already closed, and the 'close' listener below would never fire:
  // open nothing for it.
  if (res.destroyed) return;

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(resolved, { throwIfNoEntry: false });
  } catch {
    return notFound(res);
  }
  if (!stat?.isFile()) return notFound(res);

  const ext = path.extname(resolved).toLowerCase();
  const contentType = Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : OCTET_STREAM;
  const named =
    opts.downloadName && SAFE_DOWNLOAD_NAME.test(opts.downloadName)
      ? `; filename="${opts.downloadName}"`
      : "";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  if (contentType === OCTET_STREAM) {
    // Unknown or SVG: never render inline from our origin — force a download.
    res.setHeader("Content-Disposition", `attachment${named}`);
  } else if (named) {
    res.setHeader("Content-Disposition", `inline${named}`);
  }
  // Private files must not be cached by shared proxies; public imagery keeps its
  // long immutable cache.
  res.setHeader(
    "Cache-Control",
    opts.cache === "public" ? "public, max-age=86400, immutable" : "private, no-store, max-age=0",
  );

  const stream = fs.createReadStream(resolved);
  stream.on("error", (err) => {
    logError("Stored upload could not be read", err, { file: path.basename(resolved) });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    for (const header of [
      "Content-Type",
      "Content-Length",
      "Content-Disposition",
      "Cache-Control",
    ]) {
      res.removeHeader(header);
    }
    notFound(res);
  });
  // A client that goes away from here on closes the file with it.
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
