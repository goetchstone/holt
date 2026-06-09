// /app/src/pages/api/admin/service/import-sheet.ts
//
// ADMIN-only multipart endpoint that imports an Updated Customer
// Service Sheet (.xlsx) into ServiceCase + ServiceCaseNote.
//
// Request:
//   POST /api/admin/service/import-sheet
//   Content-Type: multipart/form-data
//   Fields:
//     file:    the .xlsx to import (required)
//     dryRun:  "true" | "false" (default "true" — safer)
//
// Response: ServiceCaseSheetImportResult from runServiceCaseSheetImport.
//
// Idempotency: each row's externalSourceId is a SHA256 hash of its
// timestamp + name + order# + sheet name. Re-uploading the same file
// is a no-op (0 created, 0 updated, all notes already exist by GUID).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { createSecureForm } from "@/lib/secureUpload";
import { runServiceCaseSheetImport } from "@/lib/runServiceCaseSheetImport";
import { logger, logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import fs from "node:fs";
import type { File as FormidableFile } from "formidable";

export const config = { api: { bodyParser: false } };

async function parseUploadedFile(
  req: NextApiRequest,
): Promise<{ file: FormidableFile; dryRun: boolean }> {
  return new Promise((resolve, reject) => {
    const form = createSecureForm("CSV_XLSX");
    form.parse(req, (err, rawFields, files) => {
      if (err) return reject(err);
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return reject(new Error("No file uploaded"));
      const dryRunRaw = Array.isArray(rawFields.dryRun)
        ? rawFields.dryRun[0]
        : (rawFields.dryRun as string | undefined);
      // Default to dry-run UNLESS the operator explicitly opts in.
      const dryRun = dryRunRaw == null ? true : dryRunRaw !== "false";
      resolve({ file, dryRun });
    });
  });
}

export default requireAuthWithRole(
  ["ADMIN", "SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    // GET: return last-sync status for the admin page header. Reads
    // straight from ServiceCase.externalSourceLastSeen — no separate
    // audit log to keep in sync.
    if (req.method === "GET") {
      const agg = await prisma.serviceCase.aggregate({
        where: { externalSource: "cs-sheet" },
        _max: { externalSourceLastSeen: true },
        _count: { _all: true },
      });
      return res.status(200).json({
        importedCaseCount: agg._count._all,
        lastSyncAt: agg._max.externalSourceLastSeen,
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    let filePath: string | undefined;
    try {
      const { file, dryRun } = await parseUploadedFile(req);
      filePath = file.filepath;
      const buffer = fs.readFileSync(file.filepath);

      const createdBy = session?.user?.email || "cs-sheet-import";
      const result = await runServiceCaseSheetImport(buffer, { dryRun, createdBy });

      // No separate audit-log write — the admin page reads the
      // "last sync" timestamp directly from MAX(externalSourceLastSeen)
      // on ServiceCase, which is the actual source of truth for "when
      // did the importer last touch a row?"
      logger.info("service-case-sheet-import complete", {
        dryRun,
        casesCreated: result.casesCreated,
        casesUpdated: result.casesUpdated,
        notesCreated: result.notesCreated,
        notesSkipped: result.notesSkipped,
        unmatched: result.unmatched.length,
        errors: result.errors.length,
        elapsedMs: result.elapsedMs,
      });

      return res.status(200).json(result);
    } catch (err) {
      logError("service-case-sheet-import failed", err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: msg });
    } finally {
      // Best-effort cleanup of the uploaded temp file.
      if (filePath) {
        fs.unlink(filePath, () => {
          /* ignore */
        });
      }
    }
  },
);
