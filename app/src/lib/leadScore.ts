// /app/src/lib/leadScore.ts
//
// Lead scoring algorithm. Combines sales history, wealth signals, and
// Windfall life-event signals into a 0-100 score with a simple tier
// classification. Pure function — no DB.
//
// Score breakdown (max 100):
// - Lifetime spend (0-40)
// - Department breadth (0-15)
// - Customer level — peak, never-decreases (0-20)
// - Wealth tier (0-20) — null contributes 0, so sales-only customers still score
// - Recent activity (0-5)
// - Life events (0-10, capped) — bonus on top, final score still capped at 100.
//   A recently-moved customer very likely needs furniture; new mortgage,
//   recent divorce, "money in motion" events also correlate with buying.
//
// Tiers: 70+ Hot, 50-69 Warm, 30-49 Cool, <30 New

export type LeadTier = "HOT" | "WARM" | "COOL" | "NEW";

export interface LeadScoreInput {
  lifetimeSpend?: number | null;
  lifetimeOrderCount?: number | null;
  customerLevel?: number | null;
  peakCustomerLevel?: number | null;
  departmentCount?: number | null;
  lastOrderDate?: Date | string | null;
  wealthTier?: string | null;
  // Windfall life-event signals. Each adds a small bonus because furniture
  // buying frequently coincides with these transitions. Stack with a cap
  // so no single signal dominates.
  recentMover?: boolean | null;
  recentMortgage?: boolean | null;
  recentlyDivorced?: boolean | null;
  moneyInMotion?: boolean | null;
  liquidityTrigger?: boolean | null;
}

export interface LeadScoreBreakdown {
  score: number;
  tier: LeadTier;
  factors: {
    spend: number;
    breadth: number;
    level: number;
    wealth: number;
    recency: number;
    lifeEvents: number;
  };
  // Which life-event triggers fired — useful for "why is this HOT?" tooltips.
  lifeEventReasons: string[];
}

function spendPoints(spend: number): number {
  if (spend >= 10000) return 40;
  if (spend >= 5000) return 25 + Math.floor(((spend - 5000) / 5000) * 15); // scale to 40
  if (spend >= 1000) return 15 + Math.floor(((spend - 1000) / 4000) * 10); // scale to 25
  if (spend >= 100) return Math.floor((spend / 1000) * 15); // scale to 15
  return 0;
}

function breadthPoints(count: number): number {
  if (count >= 4) return 15;
  if (count >= 3) return 10;
  if (count >= 2) return 5;
  if (count >= 1) return 2;
  return 0;
}

function levelPoints(level: number | null | undefined): number {
  if (!level) return 0;
  if (level >= 4) return 20;
  if (level >= 3) return 15;
  if (level >= 2) return 10;
  if (level >= 1) return 5;
  return 0;
}

function wealthPoints(tier: string | null | undefined): number {
  if (!tier) return 0;
  if (tier === "ULTRA_HIGH") return 20;
  if (tier === "VERY_HIGH") return 15;
  if (tier === "HIGH") return 10;
  if (tier === "AFFLUENT") return 5;
  return 0;
}

function recencyPoints(lastOrder: Date | string | null | undefined): number {
  if (!lastOrder) return 0;
  const d = typeof lastOrder === "string" ? new Date(lastOrder) : lastOrder;
  const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 90) return 5;
  if (days < 180) return 3;
  if (days < 365) return 1;
  return 0;
}

// Life events: each signal contributes a small bonus because it correlates
// with a furniture-buying opportunity. Stacked, capped at 10. Strongest
// single signal (recent mover) on its own is enough to bump a WARM into
// HOT territory at the margin.
const LIFE_EVENT_WEIGHTS = {
  recentMover: 5, // moving = redecorating; highest-intent signal
  recentMortgage: 3, // new home or refinance — often new furniture
  recentlyDivorced: 2, // household reset; new furniture common
  moneyInMotion: 2, // liquidity event
  liquidityTrigger: 2, // explicit Windfall "large inflow" flag
} as const;

const LIFE_EVENT_CAP = 10;

function lifeEventPoints(input: LeadScoreInput): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let raw = 0;
  if (input.recentMover) {
    raw += LIFE_EVENT_WEIGHTS.recentMover;
    reasons.push("Recent mover");
  }
  if (input.recentMortgage) {
    raw += LIFE_EVENT_WEIGHTS.recentMortgage;
    reasons.push("Recent mortgage");
  }
  if (input.recentlyDivorced) {
    raw += LIFE_EVENT_WEIGHTS.recentlyDivorced;
    reasons.push("Recently divorced");
  }
  if (input.moneyInMotion) {
    raw += LIFE_EVENT_WEIGHTS.moneyInMotion;
    reasons.push("Money in motion");
  }
  if (input.liquidityTrigger) {
    raw += LIFE_EVENT_WEIGHTS.liquidityTrigger;
    reasons.push("Liquidity trigger");
  }
  return { points: Math.min(raw, LIFE_EVENT_CAP), reasons };
}

function scoreToTier(score: number): LeadTier {
  if (score >= 70) return "HOT";
  if (score >= 50) return "WARM";
  if (score >= 30) return "COOL";
  return "NEW";
}

export function calculateLeadScore(input: LeadScoreInput): LeadScoreBreakdown {
  const lifeEvents = lifeEventPoints(input);
  const factors = {
    spend: spendPoints(Number(input.lifetimeSpend ?? 0)),
    breadth: breadthPoints(Number(input.departmentCount ?? 0)),
    // Use peak if available so dormant VIPs stay flagged
    level: levelPoints(input.peakCustomerLevel ?? input.customerLevel),
    wealth: wealthPoints(input.wealthTier),
    recency: recencyPoints(input.lastOrderDate),
    lifeEvents: lifeEvents.points,
  };

  // Sum all factors and cap at 100. Life events stack as a bonus on top of
  // the existing 0-100 distribution so adding them never lowers anyone's
  // previous score.
  const raw =
    factors.spend +
    factors.breadth +
    factors.level +
    factors.wealth +
    factors.recency +
    factors.lifeEvents;
  const score = Math.min(raw, 100);

  return {
    score,
    tier: scoreToTier(score),
    factors,
    lifeEventReasons: lifeEvents.reasons,
  };
}

export function leadTierLabel(tier: LeadTier): string {
  switch (tier) {
    case "HOT":
      return "Hot Lead";
    case "WARM":
      return "Warm";
    case "COOL":
      return "Cool";
    case "NEW":
      return "New";
  }
}
