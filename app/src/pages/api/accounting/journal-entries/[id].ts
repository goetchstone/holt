// /app/src/pages/api/accounting/journal-entries/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { transitionJournalEntry, JournalTransitionError } from "@/lib/journalEntry";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const entry = await prisma.journalEntry.findUnique({
        where: { id },
        include: {
          lines: {
            orderBy: { sortOrder: "asc" },
            include: {
              glAccount: { select: { id: true, code: true, name: true } },
            },
          },
        },
      });

      if (!entry) return res.status(404).json({ error: "Journal entry not found" });

      return res.status(200).json({
        id: entry.id,
        journalNumber: entry.journalNumber,
        journalDate: entry.journalDate,
        journalType: entry.journalType,
        status: entry.status,
        storeLocation: entry.storeLocation,
        totalDebits: Number(entry.totalDebits),
        totalCredits: Number(entry.totalCredits),
        notes: entry.notes,
        lines: entry.lines.map((l) => ({
          id: l.id,
          memo: l.memo,
          glAccount: l.glAccount,
          debit: Number(l.debit),
          credit: Number(l.credit),
          sortOrder: l.sortOrder,
        })),
      });
    } catch (err) {
      logError("GET /accounting/journal-entries/[id] error", err);
      return res.status(500).json({ error: "Failed to fetch journal entry" });
    }
  }

  if (req.method === "PUT") {
    const { status } = req.body;

    try {
      // The transition table and the line-balance guard used to live here,
      // which made HTTP the only way to post an entry by the rules.
      // lib/journalEntry.ts owns them now; this route maps the domain error
      // onto the status codes it already promised.
      if (status) {
        const updated = await transitionJournalEntry(id, status, session.user?.email || null);
        return res.status(200).json(updated);
      }

      // No status in the body: a touch, with nothing to validate.
      const entry = await prisma.journalEntry.findUnique({ where: { id } });
      if (!entry) return res.status(404).json({ error: "Journal entry not found" });

      const updated = await prisma.journalEntry.update({
        where: { id },
        data: { updatedBy: session.user?.email || null },
      });

      return res.status(200).json({
        id: updated.id,
        journalNumber: updated.journalNumber,
        status: updated.status,
      });
    } catch (err) {
      logError("PUT /accounting/journal-entries/[id] error", err);
      return res.status(500).json({ error: "Failed to update journal entry" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const entry = await prisma.journalEntry.findUnique({ where: { id } });
      if (!entry) return res.status(404).json({ error: "Journal entry not found" });

      if (entry.status !== "DRAFT") {
        return res.status(400).json({
          error: `Cannot delete a ${entry.status} journal entry`,
        });
      }

      await prisma.journalEntry.delete({ where: { id } });
      return res.status(200).json({ deleted: true });
    } catch (err) {
      logError("DELETE /accounting/journal-entries/[id] error", err);
      return res.status(500).json({ error: "Failed to delete journal entry" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
