// /app/src/pages/api/pricing/sales/preview.ts
//
// POST { selection, pricing, startsOn, endsOn, saleId? } -- what each selected
// product's sale price would be (GAP-06 part B), and why any is left out: no
// regular price, already in another sale on an overlapping day, not below the
// regular price, or rounded to nothing. Writes nothing.
//
// The selection is the mass price change's (chosen ids, or every product its
// filter matches, resolved again here; over its cap is refused, never cut short).
// pricing is { kind: "PERCENT_OFF", percent, rounding? } -- rounded by the run's
// rule, else the store's -- or { kind: "AMOUNT", amount }, which is not rounded.
// saleId leaves that sale's own items out of the overlap check.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import { MassChangeRefused, resolveSelection } from "@/lib/pricing/massChange";
import { parseMassChangeSelection } from "@/lib/pricing/massChangeShared";
import { previewSaleItems } from "@/lib/pricing/sales";
import { isDayKey } from "@/lib/reports/businessDay";
import { parseSalePricing, type SaleSkip } from "@/lib/pricing/salesShared";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const selection = parseMassChangeSelection(body.selection);
  if (!selection.ok) return res.status(400).json({ error: selection.error });
  const pricing = parseSalePricing(body.pricing);
  if (!pricing.ok) return res.status(400).json({ error: pricing.error });
  const { startsOn, endsOn } = body;
  if (!isDayKey(startsOn) || !isDayKey(endsOn) || endsOn < startsOn) {
    return res
      .status(400)
      .json({ error: "Send the sale's dates (YYYY-MM-DD), last on or after first." });
  }
  const saleId = body.saleId === undefined || body.saleId === null ? null : Number(body.saleId);
  if (saleId !== null && !(Number.isInteger(saleId) && saleId > 0)) {
    return res.status(400).json({ error: "saleId must be a sale's id." });
  }

  try {
    const productIds = await resolveSelection(selection.value);
    const { pricing: pricingConfig } = await getAppSettings();
    const rows = await previewSaleItems({
      productIds,
      pricing: pricing.value,
      startsOn,
      endsOn,
      excludeSaleId: saleId,
      pricingConfig,
    });
    const skipped: Partial<Record<SaleSkip, number>> = {};
    for (const row of rows) if (row.skipped) skipped[row.skipped] = (skipped[row.skipped] ?? 0) + 1;
    return res.status(200).json({
      rows,
      toSave: rows.filter((r) => !r.skipped).length,
      skipped,
      rounding:
        pricing.value.kind === "PERCENT_OFF"
          ? (pricing.value.rounding ?? pricingConfig.retailRounding)
          : null,
    });
  } catch (err) {
    if (err instanceof MassChangeRefused) return res.status(400).json({ error: err.message });
    logError("Sale preview failed", err);
    return res.status(500).json({ error: "Couldn't work out the sale prices." });
  }
}

export default requirePermission("catalog.pricing", handler);
