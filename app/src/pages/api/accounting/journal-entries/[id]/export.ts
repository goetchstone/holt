// /app/src/pages/api/accounting/journal-entries/[id]/export.ts
//
// One journal entry as a file for the accounting package: tab-delimited by
// default (its General Journal import), or CSV with ?format=csv. The rows are
// built by journalEntryFileRows in lib/quickbooksExport.ts, pure and tested,
// dated by the journal's business day in the store's zone.

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { crlfCsv } from "@/lib/csvExport";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { journalEntryFileRows, journalFileDate, tabDelimited } from "@/lib/quickbooksExport";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  const format = (req.query.format as string) || "tab";

  try {
    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { sortOrder: "asc" },
          include: {
            glAccount: { select: { code: true, name: true } },
          },
        },
      },
    });

    if (!entry) return res.status(404).json({ error: "Journal entry not found" });

    const timeZone = await getBusinessTimeZone();
    const file = {
      journalNumber: entry.journalNumber,
      journalType: entry.journalType,
      journalDate: entry.journalDate,
      lines: entry.lines.map((l) => ({
        accountCode: l.glAccount.code,
        accountName: l.glAccount.name,
        memo: l.memo,
        debit: Number(l.debit),
        credit: Number(l.credit),
      })),
    };
    const rows = journalEntryFileRows(file, timeZone);
    const fileDate = journalFileDate(file, timeZone).replace(/\//g, "");

    if (format === "csv") {
      // CRLF rows; a newline inside a quoted memo is kept as it is.
      const body = crlfCsv(rows);

      await auditLog("DATA_EXPORTED", auditActor(session), {
        summary: `Journal entry ${id} exported`,
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="GenJrnl${fileDate}.csv"`);
      return res.status(200).send(body);
    }

    // Default: tab-delimited (matches the accounting package's GenJrnl import format)
    const body = tabDelimited(rows);

    res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="GenJrnl${fileDate}.txt"`);
    return res.status(200).send(body);
  } catch (err) {
    logError("GET /accounting/journal-entries/[id]/export error", err);
    return res.status(500).json({ error: "Failed to export journal entry" });
  }
}

export default requirePermission("accounting.read", handler);
