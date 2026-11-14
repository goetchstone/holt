// /app/src/pages/api/pricing/mass-change/preview.ts
//
// POST { selection, operation } -- what a mass price change would do to each
// product (GAP-06), and why any is left out. Writes nothing; apply sends the
// rows back. Over MASS_CHANGE_MAX_PRODUCTS is refused, never cut short.
//
// Cost × markup needs "View cost" too (SEC-14, lib/auth/costVisibility.ts): its
// new prices are cost times a markup the caller can see, so cost divides back
// out, and "No cost" names the products without one. The list strips cost from
// a caller without View cost; the rest of the screen stays theirs, but this one
// operation's answer IS cost, so there is nothing left to strip it to.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { WITH_COST, canViewCost } from "@/lib/auth/costVisibility";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import { MassChangeRefused, previewMassChange, resolveSelection } from "@/lib/pricing/massChange";
import {
  parseMassChangeOperation,
  parseMassChangeSelection,
  type MassChangeSkip,
} from "@/lib/pricing/massChangeShared";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  _session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const selection = parseMassChangeSelection(body.selection);
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  const operation = parseMassChangeOperation(body.operation);
  if (!operation.ok) return res.status(400).json({ error: operation.error });
  if (operation.value.retail.kind === "FROM_MARKUP" && !canViewCost(access)) {
    return res
      .status(403)
      .json({ error: 'Pricing from cost × markup needs the "View cost" permission.' });
  }

  try {
    const ids = await resolveSelection(selection.value);
    const { pricing } = await getAppSettings();
    const rows = await previewMassChange(ids, operation.value, pricing);
    const skipped: Partial<Record<MassChangeSkip, number>> = {};
    for (const row of rows) if (row.skipped) skipped[row.skipped] = (skipped[row.skipped] ?? 0) + 1;
    return res.status(200).json({
      rows,
      toChange: rows.filter((r) => !r.skipped).length,
      skipped,
      rounding: operation.value.rounding ?? pricing.retailRounding,
    });
  } catch (err) {
    if (err instanceof MassChangeRefused) return res.status(400).json({ error: err.message });
    logError("Mass price change preview failed", err);
    return res.status(500).json({ error: "Couldn't work out the new prices." });
  }
}

export default requirePermission("catalog.pricing", handler, WITH_COST);
