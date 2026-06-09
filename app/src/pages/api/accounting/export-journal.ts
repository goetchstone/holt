// /app/src/pages/api/accounting/export-journal.ts
//
// Date-range General Journal export for QuickBooks / accountant handoff. Pulls
// every journal entry in [from, to] and emits a single CSV in the proven
// General Journal column shape. The anti-lock-in promise extends to the books:
// an operator can hand their accountant a clean journal any time, no support
// ticket. ADMIN only (financial data).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { rowsToCsv } from "@/lib/csv";
import { journalEntriesToRows, type JournalEntryInput } from "@/lib/quickbooksExport";
import { logError } from "@/lib/logger";

// Parse a YYYY-MM-DD query param to a UTC Date. Returns null on absent/invalid.
function parseDateParam(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (!from || !to) {
    return res.status(400).json({ error: "from and to dates are required (YYYY-MM-DD)." });
  }
  if (from > to) {
    return res.status(400).json({ error: "from date must be on or before to date." });
  }

  // Include the whole `to` day by ranging to the next midnight (exclusive).
  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);

  try {
    const where: Prisma.JournalEntryWhereInput = {
      journalDate: { gte: from, lt: toExclusive },
    };

    const entries = await prisma.journalEntry.findMany({
      where,
      orderBy: [{ journalDate: "asc" }, { journalNumber: "asc" }],
      include: {
        lines: {
          orderBy: { sortOrder: "asc" },
          include: { glAccount: { select: { code: true, name: true } } },
        },
      },
    });

    const input: JournalEntryInput[] = entries.map((entry) => ({
      journalNumber: entry.journalNumber,
      journalDate: entry.journalDate,
      lines: entry.lines.map((line) => ({
        accountCode: line.glAccount.code,
        accountName: line.glAccount.name,
        memo: line.memo,
        debit: Number(line.debit),
        credit: Number(line.credit),
      })),
    }));

    const rows = journalEntriesToRows(input);
    const csv = rowsToCsv(rows);
    const fromStr = req.query.from as string;
    const toStr = req.query.to as string;
    const body = csv || `# No journal entries between ${fromStr} and ${toStr}`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="general-journal-${fromStr}-to-${toStr}.csv"`,
    );
    return res.status(200).send(body);
  } catch (err) {
    logError("Journal export failed", err);
    return res.status(500).json({ error: "Export failed. Check the server logs for details." });
  }
});
