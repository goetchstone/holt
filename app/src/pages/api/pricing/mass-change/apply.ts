// /app/src/pages/api/pricing/mass-change/apply.ts
//
// POST { rows, note? } -- apply a previewed mass price change (GAP-06) in one
// transaction: rows whose price moved since the preview are refused as stale
// and reported, locked products are kept, the rest change through the retail
// writer under a new batch id, recorded as PRICES_ADJUSTED. No undo: a reversal
// is another mass change.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { applyMassChange } from "@/lib/pricing/massChange";
import { RetailWriteError } from "@/lib/pricing/retailWriter";
import { MASS_CHANGE_NOTE_MAX, parseMassChangeApplyRows } from "@/lib/pricing/massChangeShared";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rows = parseMassChangeApplyRows(body.rows);
  if (!rows.ok) return res.status(400).json({ error: rows.error });
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return res.status(400).json({ error: "The note must be text." });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MASS_CHANGE_NOTE_MAX) {
    return res
      .status(400)
      .json({ error: `Keep the note under ${MASS_CHANGE_NOTE_MAX} characters.` });
  }

  try {
    const result = await applyMassChange(rows.value, {
      actor: auditActor(session),
      note: note || null,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof RetailWriteError) return res.status(400).json({ error: err.message });
    logError("Mass price change failed", err);
    return res.status(500).json({ error: "The price change failed; nothing was changed." });
  }
}

export default requirePermission("catalog.pricing", handler);
