// /app/src/lib/purchasing/landedCostShared.ts
//
// GAP-02: landed cost -- what a unit costs once freight, duty and crating are
// spread onto its price -- as plain arithmetic, shared by the PO screen and the
// server (lib/purchasing/landedCost.ts). Client-safe: no Prisma here.
//
// The owner's decision (2026-10-30, docs/DECISIONS.md 26): each product keeps
// an average landed cost that values stock and is the cost a new sale takes;
// catalog cost stays the vendor's price, which retail is figured from. How a
// charge is split across lines is the store's choice (Settings), by value
// unless set otherwise, and the buyer may pick another split for one charge.

/** The ways a charge can be split across a PO's lines; the one home for the list. */
export const LANDED_COST_SPLITS = {
  VALUE: {
    label: "By value",
    help: "Each line takes its share of what the shipment cost.",
  },
  QUANTITY: {
    label: "By quantity",
    help: "Each unit takes an equal share.",
  },
  VOLUME: {
    label: "By cubic volume",
    help: "Each line takes its share of the space the shipment fills, from its product's dimensions.",
  },
} as const;

export type LandedCostSplit = keyof typeof LANDED_COST_SPLITS;

export const LANDED_COST_SPLIT_KEYS = Object.keys(LANDED_COST_SPLITS) as LandedCostSplit[];

export function isLandedCostSplit(value: unknown): value is LandedCostSplit {
  return typeof value === "string" && Object.hasOwn(LANDED_COST_SPLITS, value);
}

/** A PO line as a charge sees it. */
export interface ChargeLine {
  id: number;
  /** Ordered quantity; a zero-quantity line is cancelled (rule 31) and takes no share. */
  quantity: number;
  unitCost: number;
  /** Cubic volume of one unit, or null when its product has no dimensions. */
  volume: number | null;
  /** How the line is named in a refusal. */
  label: string;
}

type Allocation = { ok: true; shares: Map<number, number> } | { ok: false; problem: string };

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function weightOf(line: ChargeLine, split: LandedCostSplit): number | null {
  if (split === "VALUE") return line.quantity * Math.max(0, line.unitCost);
  if (split === "QUANTITY") return line.quantity;
  return line.volume != null && line.volume > 0 ? line.quantity * line.volume : null;
}

const NOTHING_TO_SPLIT: Record<LandedCostSplit, string> = {
  VALUE: "The lines have no cost to split this by value; split it by quantity instead.",
  QUANTITY: "This PO has no lines to spread a charge over.",
  VOLUME: "The lines have no volume to split this by; split it another way.",
};

/**
 * Spread `amount` across the lines by `split`. Each share is in cents and the
 * shares add up to the amount exactly: the cents left by rounding go to the
 * lines with the largest remainders.
 */
export function allocateCharge(
  amount: number,
  lines: readonly ChargeLine[],
  split: LandedCostSplit,
): Allocation {
  const live = lines.filter((l) => l.quantity > 0);
  const weights: number[] = [];
  for (const line of live) {
    const w = weightOf(line, split);
    if (w === null) {
      return {
        ok: false,
        problem: `${line.label} has no dimensions: add them on the product, or split this charge another way.`,
      };
    }
    weights.push(w);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { ok: false, problem: NOTHING_TO_SPLIT[split] };

  const cents = Math.round(amount * 100);
  const raw = weights.map((w) => (cents * w) / total);
  const floors = raw.map(Math.floor);
  let left = cents - floors.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((r, i) => ({ i, rest: r - floors[i] }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return { ok: true, shares: new Map(live.map((l, i) => [l.id, floors[i] / 100])) };
}

/**
 * Each line's charge per unit, from every charge on the PO. A charge whose
 * split no longer fits the lines (a line added since has no dimensions) is
 * spread by value, then by quantity, rather than holding up a receipt.
 */
export function perUnitCharges(
  charges: readonly { amount: number; splitBy: LandedCostSplit }[],
  lines: readonly ChargeLine[],
): Map<number, number> {
  const perUnit = new Map<number, number>();
  for (const charge of charges) {
    const tries: LandedCostSplit[] = [charge.splitBy, "VALUE", "QUANTITY"];
    for (const split of tries) {
      const allocation = allocateCharge(charge.amount, lines, split);
      if (!allocation.ok) continue;
      for (const line of lines) {
        const share = allocation.shares.get(line.id);
        if (share !== undefined) {
          perUnit.set(line.id, (perUnit.get(line.id) ?? 0) + share / line.quantity);
        }
      }
      break;
    }
  }
  return perUnit;
}

/** A line's landed unit cost: its unit cost and its charges per unit. */
export function landedUnitCost(unitCost: number, chargePerUnit: number): number {
  return round4(unitCost + chargePerUnit);
}

/**
 * The average after a receipt: what was on hand at the old average and what
 * arrived at its landed cost, over both. Stock below zero (oversold) counts as
 * none. With no average yet, the receipt's cost is the average.
 */
export function addToAverage(args: {
  onHand: number;
  average: number | null;
  quantity: number;
  unitCost: number;
}): number | null {
  if (!(args.quantity > 0)) return args.average;
  if (args.average === null) return round4(args.unitCost);
  const held = Math.max(0, args.onHand);
  return round4((held * args.average + args.quantity * args.unitCost) / (held + args.quantity));
}

/**
 * The average after a receipt is taken back: the receipt's units at the cost
 * they came in at, out of what is on hand. When nothing would be left, or
 * later moves make the arithmetic go below zero, the average stands.
 */
export function removeFromAverage(args: {
  onHand: number;
  average: number | null;
  quantity: number;
  unitCost: number;
}): number | null {
  const remaining = args.onHand - args.quantity;
  if (args.average === null || !(remaining > 0)) return args.average;
  const next = (args.onHand * args.average - args.quantity * args.unitCost) / remaining;
  return next < 0 ? args.average : round4(next);
}

/**
 * The average after a charge changes on goods already received: the change in
 * value over what is on hand. Null `average` or nothing on hand: the change has
 * no stock to land on, and the average stands (absorbed: false).
 */
export function spreadOverStock(args: { onHand: number; average: number | null; delta: number }): {
  average: number | null;
  absorbed: boolean;
} {
  if (args.average === null || !(args.onHand > 0)) {
    return { average: args.average, absorbed: args.delta === 0 };
  }
  return { average: round4(Math.max(0, args.average + args.delta / args.onHand)), absorbed: true };
}

/**
 * What a unit of a product costs Holt: its landed cost once it has one, else
 * its catalog cost. The one rule stock value and a new sale's cost read.
 */
export function productCost(product: {
  landedCost?: number | string | { toString(): string } | null;
  baseCost?: number | string | { toString(): string } | null;
}): number | null {
  if (product.landedCost != null) return Number(product.landedCost);
  if (product.baseCost != null) return Number(product.baseCost);
  return null;
}

/**
 * A new sale line's unit cost. A catalog product sells at what it cost Holt
 * (productCost), whatever a screen sent; a configured or custom line, which has
 * no catalog product, carries the configurator's cost. Zero when neither is known.
 */
export function saleUnitCost(
  catalogProduct: Parameters<typeof productCost>[0] | null | undefined,
  sentCost: number | null | undefined,
): number {
  if (catalogProduct) return productCost(catalogProduct) ?? 0;
  return sentCost != null && sentCost > 0 ? sentCost : 0;
}

/**
 * A count report's value of one unit: what it cost Holt (productCost), else
 * half its retail when no cost is known -- the count reports' long-standing
 * stand-in -- else 0.
 */
export function countUnitValue(
  product: Parameters<typeof productCost>[0] & {
    baseRetail?: number | string | { toString(): string } | null;
  },
): number {
  const cost = productCost(product);
  if (cost) return cost;
  return product.baseRetail != null ? Number(product.baseRetail) * 0.5 : 0;
}

/**
 * One unit's cubic volume in cubic feet: the product's own cubic feet when it
 * has them, else its dimensions (taken as inches, the catalog's unit) over
 * 1,728. Null when neither is complete.
 */
export function unitVolume(product: {
  cubicFeet?: number | null;
  width?: number | null;
  length?: number | null;
  depth?: number | null;
  height?: number | null;
}): number | null {
  if (product.cubicFeet != null && product.cubicFeet > 0) return product.cubicFeet;
  const across = product.width ?? product.length;
  const sides = [across, product.depth, product.height];
  if (sides.some((side) => side == null || !(side > 0))) return null;
  return (sides as number[]).reduce((a, b) => a * b, 1) / 1728;
}

export const MAX_CHARGE_DESCRIPTION = 200;

/** A charge as the PO screen sends it. */
export interface ChargeInput {
  description: string;
  amount: number;
  splitBy: LandedCostSplit;
}

/** Read a charge from a request; the split defaults to the store's. */
export function parseCharge(
  body: unknown,
  defaultSplit: LandedCostSplit,
): { ok: true; value: ChargeInput } | { ok: false; problem: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (!description)
    return { ok: false, problem: "Say what the charge is for: freight, duty, crating." };
  if (description.length > MAX_CHARGE_DESCRIPTION) {
    return {
      ok: false,
      problem: `A charge's description can be at most ${MAX_CHARGE_DESCRIPTION} characters.`,
    };
  }
  const amount = typeof b.amount === "number" ? b.amount : Number.NaN;
  if (!Number.isFinite(amount) || !(Math.round(amount * 100) > 0) || amount > 10_000_000) {
    return { ok: false, problem: "The charge must be an amount more than 0." };
  }
  if (b.splitBy !== undefined && b.splitBy !== null && !isLandedCostSplit(b.splitBy)) {
    return { ok: false, problem: "A charge is split by value, by quantity or by cubic volume." };
  }
  return {
    ok: true,
    value: {
      description,
      amount: Math.round(amount * 100) / 100,
      splitBy: isLandedCostSplit(b.splitBy) ? b.splitBy : defaultSplit,
    },
  };
}
