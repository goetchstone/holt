// /app/src/pages/api/accounting/journal-entries/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { assertBalanced } from "@/lib/journalEntry";
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

    const validTransitions: Record<string, string[]> = {
      DRAFT: ["POSTED"],
      POSTED: ["EXPORTED"],
      EXPORTED: [],
    };

    try {
      const entry = await prisma.journalEntry.findUnique({ where: { id } });
      if (!entry) return res.status(404).json({ error: "Journal entry not found" });

      if (status) {
        const allowed = validTransitions[entry.status] || [];
        if (!allowed.includes(status)) {
          return res.status(400).json({
            error: `Cannot transition from ${entry.status} to ${status}`,
          });
        }

        // Phase 0 BLOCKER B4: refuse DRAFT->POSTED and POSTED->EXPORTED
        // when sum(debits) != sum(credits). Defense-in-depth: even though
        // buildJournalLines produces balanced output today, a future
        // hand-edit on the JE detail page or a future code change could
        // break the invariant silently. Better to refuse at the boundary
        // than ship an unbalanced entry to QuickBooks.
        if (status === "POSTED" || status === "EXPORTED") {
          const lines = await prisma.journalEntryLine.findMany({
            where: { journalEntryId: id },
            select: { debit: true, credit: true },
          });
          const balance = assertBalanced(
            lines.map((l) => ({
              debit: Number(l.debit),
              credit: Number(l.credit),
            })),
          );
          if (!balance.ok) {
            return res.status(400).json({
              error: balance.error,
              totalDebits: balance.totalDebits,
              totalCredits: balance.totalCredits,
              diff: balance.diff,
            });
          }
        }
      }

      const updated = await prisma.journalEntry.update({
        where: { id },
        data: {
          status: status || undefined,
          updatedBy: session.user?.email || null,
        },
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
