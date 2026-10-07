// /app/src/lib/opportunityTiles.ts
//
// Shared definitions for the /reports/opportunities hub. Each tile describes
// a marketing segment: a Prisma filter + plain-English copy + optional
// seasonal gating. Both the counts endpoint and the drill endpoint import
// from here -- so the list never drifts (CLAUDE.md rule 37).
//
// Adding a tile: append to OPPORTUNITY_TILES. The hub page and its two API
// routes pick it up automatically. Titles must pass the 6th-8th grade test:
// would a manager say this out loud to a coworker at a shift change?

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type TileId =
  | "big-wallets"
  | "second-home"
  | "landlord"
  | "boat-crowd"
  | "single-department"
  | "welcome-back"
  | "life-event"
  | "dormant-vips"
  | "missing-pieces"
  | "christmas-lapse";

export interface OpportunityTile {
  id: TileId;
  title: string;
  description: string;
  // Returns a CustomerWhereInput. `now` is injected so the function is pure
  // and deterministic for tests (otherwise date-relative filters drift).
  // The Missing Pieces tile returns a Promise because it loads its rules
  // from ProductPairing at request time -- any tile that needs DB lookups
  // during filter construction can widen to async here.
  buildWhere: (now: Date) => Prisma.CustomerWhereInput | Promise<Prisma.CustomerWhereInput>;
  // Optional gate -- when false, the hub hides the tile entirely. Used for
  // seasonal segments so the Christmas tile doesn't clutter summer views.
  shouldShow?: (now: Date) => boolean;
  // Rough per-customer revenue estimate for the tile's "potential" subline.
  // Not exact math; deliberately coarse so nobody treats it as a forecast.
  avgEstPerCustomer: number;
}

// Helpers ---------------------------------------------------------------------

function monthsAgo(now: Date, months: number): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const HIGH_WEALTH_TIERS = ["HIGH", "VERY_HIGH", "ULTRA_HIGH"];

// Minimal pairing shape for the Missing Pieces builder. Exported so the
// tile can be tested with a stub list without importing Prisma client.
export interface PairingRule {
  fromDepartmentId: number;
  fromCategoryId: number | null;
  toDepartmentId: number;
  toCategoryId: number | null;
  windowDays: number;
}

/**
 * Translate a list of active ProductPairing rules into a CustomerWhereInput
 * whose matches are: customers with at least one From purchase inside the
 * window AND zero To purchases ever. An OR across every pairing means one
 * customer can match multiple rules -- we don't multi-count here because
 * Prisma de-dupes on Customer.id.
 */
export function buildMissingPiecesWhere(
  pairings: PairingRule[],
  now: Date,
): Prisma.CustomerWhereInput {
  if (pairings.length === 0) {
    // No rules configured -> empty segment.
    return { id: { in: [] } };
  }

  const orClauses: Prisma.CustomerWhereInput[] = pairings.map((p) => {
    const windowStart = new Date(now.getTime() - p.windowDays * 24 * 60 * 60 * 1000);

    const fromProductFilter: Prisma.ProductWhereInput = {
      departmentId: p.fromDepartmentId,
      ...(p.fromCategoryId ? { categoryId: p.fromCategoryId } : {}),
    };
    const toProductFilter: Prisma.ProductWhereInput = {
      departmentId: p.toDepartmentId,
      ...(p.toCategoryId ? { categoryId: p.toCategoryId } : {}),
    };

    return {
      salesOrders: {
        some: {
          // Intentionally NOT using SALES_REVENUE_STATUSES — these
          // tiles ask "does the customer OWN a product from dept X
          // today?" not "did they ever pay money?" Returned items
          // came back, so RETURNED orders must be excluded here.
          // Rewrites (order rewrites) keep their ORDER status so the
          // active "owns it" answer falls out naturally.
          status: { in: ["ORDER", "FULFILLED"] },
          orderDate: { gte: windowStart },
          lineItems: {
            some: {
              lineItemStatus: { not: "CANCELLED" },
              product: fromProductFilter,
            },
          },
        },
      },
      NOT: {
        salesOrders: {
          some: {
            lineItems: {
              some: {
                lineItemStatus: { not: "CANCELLED" },
                product: toProductFilter,
              },
            },
          },
        },
      },
    };
  });

  return { OR: orClauses };
}

// Tiles -----------------------------------------------------------------------

export const OPPORTUNITY_TILES: OpportunityTile[] = [
  {
    id: "big-wallets",
    title: "Big wallets, small baskets",
    description:
      "Wealthy customers who have barely bought anything from us. The biggest untapped pool.",
    avgEstPerCustomer: 800,
    buildWhere: () => ({
      windfallEnrichment: { wealthTier: { in: HIGH_WEALTH_TIERS } },
      lifetimeSpend: { lt: 2000 },
      lifetimeOrderCount: { gte: 1 },
    }),
  },
  {
    id: "second-home",
    title: "They have a second home",
    description:
      "Multi-property owners who haven't let us furnish the other house yet. Bedroom, outdoor, accessories.",
    avgEstPerCustomer: 1200,
    buildWhere: () => ({
      windfallEnrichment: { multiPropertyOwner: true },
      lifetimeSpend: { lt: 5000 },
    }),
  },
  {
    id: "landlord",
    title: "Landlord special",
    description: "Rental property owners. Think durable bedroom + living room sets, bulk orders.",
    avgEstPerCustomer: 900,
    buildWhere: () => ({
      windfallEnrichment: { rentalPropertyOwner: true },
      lifetimeSpend: { lt: 5000 },
    }),
  },
  {
    id: "boat-crowd",
    title: "Boat and lake house crowd",
    description:
      "Existing customers who own a boat. Outdoor furniture, entertaining pieces, rugs for the cabin.",
    avgEstPerCustomer: 700,
    buildWhere: () => ({
      windfallEnrichment: { boatOwner: true },
      lifetimeSpend: { gte: 500 },
    }),
  },
  {
    id: "single-department",
    title: "Bought one thing, never came back for the rest",
    description:
      "Spent $500+ in one department and never shopped another. Biggest cross-sell foundation.",
    avgEstPerCustomer: 600,
    buildWhere: () => ({
      departmentCount: 1,
      lifetimeSpend: { gte: 500 },
    }),
  },
  {
    id: "welcome-back",
    title: "Welcome back -- finish the set",
    description:
      "First-time buyers in the last 90 days. Nudge them toward their second purchase while the relationship is warm.",
    avgEstPerCustomer: 500,
    buildWhere: (now) => ({
      firstOrderDate: { gte: daysAgo(now, 90) },
      lifetimeOrderCount: { gte: 1 },
    }),
  },
  {
    id: "life-event",
    title: "Something big changed in their life",
    description:
      "Recent mover, new mortgage, or cashed out an asset. People in transition buy furniture.",
    avgEstPerCustomer: 1500,
    buildWhere: () => ({
      windfallEnrichment: {
        OR: [{ recentMover: true }, { recentMortgage: true }, { liquidityTrigger: true }],
      },
    }),
  },
  {
    id: "missing-pieces",
    title: "Missing pieces",
    description:
      "Customers who bought part of a set and never came back for the rest. Rules configured in Admin -> Product Pairings.",
    avgEstPerCustomer: 700,
    buildWhere: async (now) => {
      const pairings = await prisma.productPairing.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: {
          fromDepartmentId: true,
          fromCategoryId: true,
          toDepartmentId: true,
          toCategoryId: true,
          windowDays: true,
        },
      });
      return buildMissingPiecesWhere(pairings, now);
    },
  },
  {
    id: "dormant-vips",
    title: "Come back soon",
    description:
      "Used to spend a lot with us, has gone quiet. Smallest pool but the highest win rate per email.",
    avgEstPerCustomer: 3000,
    buildWhere: (now) => ({
      peakCustomerLevel: { gte: 3 },
      customerLevel: { lte: 1 },
      OR: [{ lastOrderDate: null }, { lastOrderDate: { lt: monthsAgo(now, 12) } }],
    }),
  },
  {
    id: "christmas-lapse",
    title: "Christmas crowd is missing",
    description:
      "Shopped Christmas last year, nothing in the cart this year. Narrow window, high urgency.",
    avgEstPerCustomer: 400,
    shouldShow: (now) => {
      // Auto-visible Oct 1 through Dec 31 so it only clutters the hub when
      // the segment actually matters.
      const month = now.getMonth(); // 0-indexed
      return month >= 9 && month <= 11;
    },
    buildWhere: (now) => {
      // "Christmas last year, nothing yet this year" --> last order earlier
      // than Sept 1 of the current calendar year.
      const septThisYear = new Date(Date.UTC(now.getUTCFullYear(), 8, 1));
      return {
        customerGroup: "CHRISTMAS",
        OR: [{ lastOrderDate: null }, { lastOrderDate: { lt: septThisYear } }],
      };
    },
  },
];

export function getTileById(id: string): OpportunityTile | undefined {
  return OPPORTUNITY_TILES.find((t) => t.id === id);
}

export function getVisibleTiles(now: Date): OpportunityTile[] {
  return OPPORTUNITY_TILES.filter((t) => !t.shouldShow || t.shouldShow(now));
}
