// /app/src/lib/reports/opportunities.ts
//
// Opportunities hub: per-tile customer counts + per-tile drilldown rows.
// Extracted from the Pages API so the App Router page + tRPC procedures share one
// source of truth. Role-aware wealth visibility is decided by the caller (the
// tRPC procedure) and passed in as canSeeWealth. Tile definitions live in
// lib/opportunityTiles.ts.

import type { PrismaClient } from "@prisma/client";
import { getVisibleTiles, getTileById, type TileId } from "@/lib/opportunityTiles";
import { calculateLeadScore, type LeadTier } from "@/lib/leadScore";
import { buildDaysSinceLastSentMap } from "@/lib/campaignDedup";

const DEDUP_WINDOW_DAYS = 30;

export interface OpportunityTileSummary {
  id: TileId;
  title: string;
  description: string;
  count: number;
  estPotential: number;
  lastSentAt: string | null;
}

export interface OpportunitiesResult {
  asOf: string;
  tiles: OpportunityTileSummary[];
}

export interface OpportunityRow {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  lifetimeSpend: number;
  lifetimeOrderCount: number;
  lastOrderDate: string | null;
  customerLevel: number | null;
  peakCustomerLevel: number | null;
  primaryDesignerName: string | null;
  customerGroup: string | null;
  leadTier: LeadTier | null;
  leadScore: number | null;
  daysSinceLastSent: number | null;
  wealthTier?: string | null;
}

export interface OpportunityDrillResult {
  tileId: string;
  title: string;
  description: string;
  rows: OpportunityRow[];
  count: number;
}

export async function getOpportunityTiles(prisma: PrismaClient): Promise<OpportunitiesResult> {
  const now = new Date();
  const tiles = getVisibleTiles(now);

  const results = await Promise.all(
    tiles.map(async (tile) => {
      const where = await tile.buildWhere(now);
      const [count, lastSend] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.campaignTarget.findFirst({
          where: { tileId: tile.id },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        }),
      ]);
      return {
        id: tile.id,
        title: tile.title,
        description: tile.description,
        count,
        estPotential: count * tile.avgEstPerCustomer,
        lastSentAt: lastSend?.sentAt.toISOString() ?? null,
      };
    }),
  );

  return { asOf: now.toISOString(), tiles: results };
}

export class OpportunityTileNotFound extends Error {}

export interface OpportunityDrillParams {
  tileId: string;
  dedup?: boolean;
  canSeeWealth: boolean;
}

export async function getOpportunityDrill(
  prisma: PrismaClient,
  params: OpportunityDrillParams,
): Promise<OpportunityDrillResult> {
  const tile = getTileById(params.tileId);
  if (!tile) throw new OpportunityTileNotFound("Unknown tile");

  const now = new Date();
  const dedup = params.dedup !== false; // default true
  const where = await tile.buildWhere(now);

  const windowStart = new Date(now.getTime() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recent = await prisma.campaignTarget.findMany({
    where: { tileId: params.tileId, sentAt: { gte: windowStart } },
    select: { customerId: true, sentAt: true },
  });
  const daysSinceMap = buildDaysSinceLastSentMap(recent, now);
  if (dedup && recent.length > 0) {
    const blocked = new Set(recent.map((r) => r.customerId));
    where.id = { notIn: [...blocked] };
  }

  const customers = await prisma.customer.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      lifetimeSpend: true,
      lifetimeOrderCount: true,
      lastOrderDate: true,
      customerLevel: true,
      peakCustomerLevel: true,
      departmentCount: true,
      customerGroup: true,
      primaryDesigner: { select: { displayName: true } },
      windfallEnrichment: {
        select: {
          wealthTier: true,
          recentMover: true,
          recentMortgage: true,
          recentlyDivorced: true,
          moneyInMotion: true,
          liquidityTrigger: true,
        },
      },
    },
    orderBy: [{ lifetimeSpend: "desc" }, { lastName: "asc" }],
    take: 5000, // hard cap — segments are always under this, guards a runaway query
  });

  const rows: OpportunityRow[] = customers.map((c) => {
    const wf = c.windfallEnrichment;
    const score = calculateLeadScore({
      lifetimeSpend: Number(c.lifetimeSpend ?? 0),
      lifetimeOrderCount: c.lifetimeOrderCount,
      customerLevel: c.customerLevel,
      peakCustomerLevel: c.peakCustomerLevel,
      departmentCount: c.departmentCount,
      lastOrderDate: c.lastOrderDate,
      wealthTier: wf?.wealthTier,
      recentMover: wf?.recentMover,
      recentMortgage: wf?.recentMortgage,
      recentlyDivorced: wf?.recentlyDivorced,
      moneyInMotion: wf?.moneyInMotion,
      liquidityTrigger: wf?.liquidityTrigger,
    });

    const row: OpportunityRow = {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: c.phone,
      lifetimeSpend: Number(c.lifetimeSpend ?? 0),
      lifetimeOrderCount: c.lifetimeOrderCount ?? 0,
      lastOrderDate: c.lastOrderDate?.toISOString() ?? null,
      customerLevel: c.customerLevel,
      peakCustomerLevel: c.peakCustomerLevel,
      primaryDesignerName: c.primaryDesigner?.displayName ?? null,
      customerGroup: c.customerGroup ?? null,
      leadTier: score.tier,
      leadScore: score.score,
      daysSinceLastSent: daysSinceMap.get(c.id) ?? null,
    };
    if (params.canSeeWealth) {
      row.wealthTier = wf?.wealthTier ?? null;
    }
    return row;
  });

  return {
    tileId: params.tileId,
    title: tile.title,
    description: tile.description,
    rows,
    count: rows.length,
  };
}
