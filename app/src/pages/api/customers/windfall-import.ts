// /app/src/pages/api/customers/windfall-import.ts
//
// Imports Windfall wealth enrichment data for customers matched by
// the POS customer code. Upserts WindfallEnrichment records keyed
// on customerId.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { computeWealthTier } from "@/lib/windfallImport";
import type { WindfallParsedRow } from "@/lib/windfallImport";

export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { rows } = req.body as { rows: WindfallParsedRow[] };

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows array is required" });
    }

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.customerCode) {
        skipped++;
        continue;
      }

      // Look up customer by the POS code
      const link = await prisma.customerExternalId.findUnique({
        where: { externalId: row.customerCode },
        select: { customerId: true },
      });

      if (!link) {
        skipped++;
        continue;
      }

      // No Windfall match — skip enrichment but don't count as error
      if (!row.windfallId && row.netWorth == null) {
        skipped++;
        continue;
      }

      // Same Windfall person can match multiple the POS codes (duplicate
      // customer records). Skip if this windfallId is already linked to a
      // different customer to avoid unique constraint violation.
      if (row.windfallId) {
        const existing = await prisma.windfallEnrichment.findUnique({
          where: { windfallId: row.windfallId },
          select: { customerId: true },
        });
        if (existing && existing.customerId !== link.customerId) {
          skipped++;
          continue;
        }
      }

      const tier = computeWealthTier(row.netWorth);
      const lastCalc = row.netWorthLastCalculated ? new Date(row.netWorthLastCalculated) : null;

      await prisma.windfallEnrichment.upsert({
        where: { customerId: link.customerId },
        create: {
          customerId: link.customerId,
          windfallId: row.windfallId,
          matchConfidence: row.matchConfidence,
          netWorth: row.netWorth,
          netWorthLow: row.netWorthLow,
          netWorthHigh: row.netWorthHigh,
          wealthTier: tier,
          netWorthLastCalculated: lastCalc,
          recentMover: row.recentMover,
          recentlyDivorced: row.recentlyDivorced,
          recentDeathInFamily: row.recentDeathInFamily,
          moneyInMotion: row.moneyInMotion,
          liquidityTrigger: row.liquidityTrigger,
          recentMortgage: row.recentMortgage,
          boatOwner: row.boatOwner,
          planeOwner: row.planeOwner,
          multiPropertyOwner: row.multiPropertyOwner,
          rentalPropertyOwner: row.rentalPropertyOwner,
          smallBusinessOwner: row.smallBusinessOwner,
          cryptoInterest: row.cryptoInterest,
          philanthropicGiver: row.philanthropicGiver,
          topPhilanthropicDonor: row.topPhilanthropicDonor,
          nonprofitBoardMember: row.nonprofitBoardMember,
          donorAdvisedFunds: row.donorAdvisedFunds,
          nteeCodes: row.nteeCodes,
          regionalFocus: row.regionalFocus,
          foundationAssociation: row.foundationAssociation,
          foundationOfficer: row.foundationOfficer,
          politicalDonor: row.politicalDonor,
          topPoliticalDonor: row.topPoliticalDonor,
          politicalParty: row.politicalParty,
          hasHouseholdDebt: row.hasHouseholdDebt,
          primaryPropertyLtv: row.primaryPropertyLtv,
          trustAssociation: row.trustAssociation,
        },
        update: {
          windfallId: row.windfallId,
          matchConfidence: row.matchConfidence,
          netWorth: row.netWorth,
          netWorthLow: row.netWorthLow,
          netWorthHigh: row.netWorthHigh,
          wealthTier: tier,
          netWorthLastCalculated: lastCalc,
          recentMover: row.recentMover,
          recentlyDivorced: row.recentlyDivorced,
          recentDeathInFamily: row.recentDeathInFamily,
          moneyInMotion: row.moneyInMotion,
          liquidityTrigger: row.liquidityTrigger,
          recentMortgage: row.recentMortgage,
          boatOwner: row.boatOwner,
          planeOwner: row.planeOwner,
          multiPropertyOwner: row.multiPropertyOwner,
          rentalPropertyOwner: row.rentalPropertyOwner,
          smallBusinessOwner: row.smallBusinessOwner,
          cryptoInterest: row.cryptoInterest,
          philanthropicGiver: row.philanthropicGiver,
          topPhilanthropicDonor: row.topPhilanthropicDonor,
          nonprofitBoardMember: row.nonprofitBoardMember,
          donorAdvisedFunds: row.donorAdvisedFunds,
          nteeCodes: row.nteeCodes,
          regionalFocus: row.regionalFocus,
          foundationAssociation: row.foundationAssociation,
          foundationOfficer: row.foundationOfficer,
          politicalDonor: row.politicalDonor,
          topPoliticalDonor: row.topPoliticalDonor,
          politicalParty: row.politicalParty,
          hasHouseholdDebt: row.hasHouseholdDebt,
          primaryPropertyLtv: row.primaryPropertyLtv,
          trustAssociation: row.trustAssociation,
        },
      });

      imported++;
    }

    logger.info("Windfall import complete", {
      imported,
      skipped,
      total: rows.length,
    });

    return res.status(200).json({
      message: `Imported ${imported} of ${rows.length} rows (${skipped} skipped)`,
      imported,
      skipped,
      total: rows.length,
    });
  } catch (err: unknown) {
    logError("Windfall import failed", err);
    const message = err instanceof Error ? err.message : "Import failed";
    return res.status(500).json({ error: message });
  }
});
