// /app/src/pages/api/pricing/mass-change/lock.ts
//
// POST { selection, locked } -- lock or unlock the prices of a selection
// (GAP-06). A locked price is kept by imports, mass changes and style edits; a
// person editing that one product can still change it. One PRICE_LOCK_CHANGED
// entry for the run.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor } from "@/lib/audit";
import { logError } from "@/lib/logger";
import { MassChangeRefused, lockMassChange, resolveSelection } from "@/lib/pricing/massChange";
import { parseMassChangeSelection } from "@/lib/pricing/massChangeShared";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const selection = parseMassChangeSelection(body.selection);
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  if (typeof body.locked !== "boolean") {
    return res.status(400).json({ error: "locked must be true or false." });
  }

  try {
    const ids = await resolveSelection(selection.value);
    const result = await lockMassChange(ids, body.locked, auditActor(session));
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof MassChangeRefused) return res.status(400).json({ error: err.message });
    logError("Mass price lock failed", err);
    return res.status(500).json({ error: "Couldn't change the price locks; nothing was changed." });
  }
}

export default requirePermission("catalog.pricing", handler);
