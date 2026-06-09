// /app/src/pages/api/accounting/journal-entries/[id]/export.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

function formatDate(d: Date): string {
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const yyyy = d.getFullYear().toString();
  return `${mm}/${dd}/${yyyy}`;
}

function formatAmount(n: number): string {
  if (n === 0) return "";
  return n.toFixed(2);
}

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

    const dateStr = formatDate(entry.journalDate);
    const dateParts = dateStr.replace(/\//g, "");

    if (format === "csv") {
      const header = "Journ #,Date,Memo,Accnt #,Debit,Credit";
      const rows = entry.lines.map((l) => {
        const debit = formatAmount(Number(l.debit));
        const credit = formatAmount(Number(l.credit));
        return `${entry.journalNumber},${dateStr},"${l.memo}",${l.glAccount.code},${debit},${credit}`;
      });

      const body = [header, ...rows].join("\r\n") + "\r\n";

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="GenJrnl${dateParts}.csv"`);
      return res.status(200).send(body);
    }

    // Default: tab-delimited (matches GenJrnl05012022.txt format)
    const header = "Journ #\tDate\tMemo\tAccnt #\tDebit\tCredit";
    const rows = entry.lines.map((l) => {
      const debit = formatAmount(Number(l.debit));
      const credit = formatAmount(Number(l.credit));
      return `${entry.journalNumber}\t${dateStr}\t${l.memo}\t${l.glAccount.code}\t${debit}\t${credit}`;
    });

    const body = [header, ...rows].join("\r\n") + "\r\n";

    res.setHeader("Content-Type", "text/tab-separated-values; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="GenJrnl${dateParts}.txt"`);
    return res.status(200).send(body);
  } catch (err) {
    logError("GET /accounting/journal-entries/[id]/export error", err);
    return res.status(500).json({ error: "Failed to export journal entry" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
