// app/prisma/seed/demo/commissionPlan.ts
//
// CommissionPlan + CommissionPlanTier. As of this seed's rebase onto
// origin/main (feat/demo-seed-data, rebased on main @ 35aecb2), the
// declarative rule engine (CommissionPlanRule / CommissionRuleTier with
// basis/accumulator/tierMode) lives ONLY on the still-unmerged
// origin/feat/commission-rule-engine branch -- `schema.prisma` on main has
// no such models (grep confirms zero matches). So this seeds the CURRENT
// (tier) model: `CommissionPlan` + `CommissionPlanTier`, exactly what
// `lib/commissionPlans.ts` / `lib/runCommissionPayouts.ts` consume today.
// If/when the rule-engine branch merges, this file is the one to convert
// to CommissionPlanRule/CommissionRuleTier.
//
// Tier thresholds are scaled down from `DEFAULT_COMMISSION_TIERS`
// (lib/commissionTiers.ts, tuned for a $750k-$2M/yr per-designer real
// store) to a range this seed's synthetic order volume can actually reach
// and cross mid-year, so the marginal-tier math in a locked payout has more
// than one bracket to show.

import type { PrismaClient } from "@prisma/client";

const SEED_ACTOR = "seed:demo";

interface TierDef {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
}

const STANDARD_TIERS: TierDef[] = [
  { label: "Up to $100k", minYtdSales: 0, maxYtdSalesExclusive: 100_000, rate: 0.03 },
  { label: "$100k – $200k", minYtdSales: 100_000, maxYtdSalesExclusive: 200_000, rate: 0.04 },
  { label: "$200k – $350k", minYtdSales: 200_000, maxYtdSalesExclusive: 350_000, rate: 0.05 },
  { label: "$350k – $600k", minYtdSales: 350_000, maxYtdSalesExclusive: 600_000, rate: 0.06 },
  { label: "Over $600k", minYtdSales: 600_000, maxYtdSalesExclusive: null, rate: 0.07 },
];

const SENIOR_TIERS: TierDef[] = [
  { label: "Up to $75k", minYtdSales: 0, maxYtdSalesExclusive: 75_000, rate: 0.04 },
  { label: "$75k – $175k", minYtdSales: 75_000, maxYtdSalesExclusive: 175_000, rate: 0.055 },
  { label: "$175k – $350k", minYtdSales: 175_000, maxYtdSalesExclusive: 350_000, rate: 0.07 },
  { label: "Over $350k", minYtdSales: 350_000, maxYtdSalesExclusive: null, rate: 0.085 },
];

export interface CommissionPlanSetup {
  standardPlanId: number;
  seniorPlanId: number;
}

async function upsertPlan(
  prisma: PrismaClient,
  name: string,
  description: string,
  isDefault: boolean,
  tiers: TierDef[],
): Promise<number> {
  const plan = await prisma.commissionPlan.upsert({
    where: { name },
    update: { description, isDefault, isActive: true },
    create: { name, description, isDefault, isActive: true, createdBy: SEED_ACTOR },
  });

  for (const [i, t] of tiers.entries()) {
    await prisma.commissionPlanTier.upsert({
      where: { planId_sortOrder: { planId: plan.id, sortOrder: i } },
      update: {
        label: t.label,
        minYtdSales: t.minYtdSales,
        maxYtdSalesExclusive: t.maxYtdSalesExclusive,
        rate: t.rate,
      },
      create: {
        planId: plan.id,
        label: t.label,
        minYtdSales: t.minYtdSales,
        maxYtdSalesExclusive: t.maxYtdSalesExclusive,
        rate: t.rate,
        sortOrder: i,
      },
    });
  }

  return plan.id;
}

export async function seedCommissionPlans(prisma: PrismaClient): Promise<CommissionPlanSetup> {
  const standardPlanId = await upsertPlan(
    prisma,
    "Standard Design Team",
    "The default marginal-tier plan every designer starts on.",
    true,
    STANDARD_TIERS,
  );
  const seniorPlanId = await upsertPlan(
    prisma,
    "Senior Design Partner",
    "Richer marginal tiers for senior designers with an assigned book of trade clients.",
    false,
    SENIOR_TIERS,
  );

  return { standardPlanId, seniorPlanId };
}
