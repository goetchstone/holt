// /app/__tests__/opportunityTiles.test.ts
//
// PLACEHOLDER TEST — Grade: A (pure helpers + structural assertions).
// Tests `getTileById`, `getVisibleTiles`, the `buildWhere(now)` shape
// for each tile (returns a Prisma where object — no DB hit), and the
// pure helper `buildMissingPiecesWhere`. Prisma is mocked only as an
// isolation shim so the import in lib/opportunityTiles.ts resolves
// without instantiating a real client.
//
// What's NOT covered here: end-to-end query of the Missing Pieces
// tile against a real DB (the `buildWhere` call that reads
// ProductPairing rows then builds the where object). That's a Phase
// 0.6.4 backfill candidate — the `buildMissingPiecesWhere` shape IS
// tested below with literal pairings, so the most-load-bearing piece
// is covered.

// Prisma client is mocked because the async Missing Pieces tile reads
// ProductPairing at query time -- we stub it per-test.
jest.mock("@/lib/prisma", () => ({
  prisma: {
    productPairing: {
      findMany: jest.fn(),
    },
  },
}));

import {
  OPPORTUNITY_TILES,
  getTileById,
  getVisibleTiles,
  buildMissingPiecesWhere,
  type TileId,
  type PairingRule,
} from "@/lib/opportunityTiles";
import { prisma } from "@/lib/prisma";

const mockedPairingsFindMany = prisma.productPairing.findMany as jest.Mock;

describe("opportunityTiles -- shared definitions", () => {
  it("exposes a non-empty list with unique ids", () => {
    expect(OPPORTUNITY_TILES.length).toBeGreaterThan(0);
    const ids = OPPORTUNITY_TILES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every tile has title, description, and a non-zero avg estimate", () => {
    for (const t of OPPORTUNITY_TILES) {
      expect(t.title).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.avgEstPerCustomer).toBeGreaterThan(0);
    }
  });

  it("buildWhere is pure -- returns the same filter object given the same `now`", async () => {
    mockedPairingsFindMany.mockResolvedValue([]);
    const now = new Date("2026-06-15T12:00:00Z");
    for (const t of OPPORTUNITY_TILES) {
      const a = JSON.stringify(await t.buildWhere(now));
      const b = JSON.stringify(await t.buildWhere(now));
      expect(a).toBe(b);
    }
  });

  describe("getTileById", () => {
    it("returns the tile for a known id", () => {
      const t = getTileById("dormant-vips");
      expect(t?.title).toContain("Come back");
    });
    it("returns undefined for an unknown id", () => {
      expect(getTileById("nope" as TileId)).toBeUndefined();
    });
  });

  describe("getVisibleTiles", () => {
    it("hides the Christmas tile outside Oct-Dec", () => {
      const summer = new Date("2026-06-15T12:00:00Z");
      const visible = getVisibleTiles(summer);
      expect(visible.find((t) => t.id === "christmas-lapse")).toBeUndefined();
    });
    it("shows the Christmas tile in October", () => {
      const october = new Date("2026-10-15T12:00:00Z");
      const visible = getVisibleTiles(october);
      expect(visible.find((t) => t.id === "christmas-lapse")).toBeDefined();
    });
    it("shows the Christmas tile in December", () => {
      const december = new Date("2026-12-20T12:00:00Z");
      const visible = getVisibleTiles(december);
      expect(visible.find((t) => t.id === "christmas-lapse")).toBeDefined();
    });
    it("always includes the big-wallets tile", () => {
      for (const month of [1, 4, 7, 11]) {
        const d = new Date(Date.UTC(2026, month, 15));
        expect(getVisibleTiles(d).find((t) => t.id === "big-wallets")).toBeDefined();
      }
    });
  });

  describe("tile filter shapes", () => {
    const now = new Date("2026-06-15T12:00:00Z");

    it("big-wallets filters by HIGH+ wealth tier and low spend", async () => {
      const w = (await getTileById("big-wallets")!.buildWhere(now)) as Record<string, unknown>;
      expect(w.windfallEnrichment).toEqual({
        wealthTier: { in: ["HIGH", "VERY_HIGH", "ULTRA_HIGH"] },
      });
      expect(w.lifetimeSpend).toEqual({ lt: 2000 });
    });

    it("dormant-vips requires peak >= 3 AND current <= 1", async () => {
      const w = (await getTileById("dormant-vips")!.buildWhere(now)) as Record<string, unknown>;
      expect(w.peakCustomerLevel).toEqual({ gte: 3 });
      expect(w.customerLevel).toEqual({ lte: 1 });
    });

    it("welcome-back uses a date 90 days prior to `now`", async () => {
      const w = (await getTileById("welcome-back")!.buildWhere(now)) as Record<string, unknown>;
      const threshold = (w.firstOrderDate as { gte: Date }).gte;
      const expectedMs = now.getTime() - 90 * 24 * 60 * 60 * 1000;
      expect(threshold.getTime()).toBe(expectedMs);
    });

    it("life-event filters on any of three triggers via OR on the enrichment relation", async () => {
      const w = (await getTileById("life-event")!.buildWhere(now)) as Record<string, unknown>;
      const enrichment = w.windfallEnrichment as { OR: Array<Record<string, boolean>> };
      expect(enrichment.OR).toHaveLength(3);
      const keys = enrichment.OR.flatMap((o) => Object.keys(o));
      expect(keys.sort()).toEqual(["liquidityTrigger", "recentMortgage", "recentMover"]);
    });

    it("christmas-lapse uses Sep 1 of the current calendar year as the cutoff", async () => {
      const now = new Date("2026-10-15T12:00:00Z");
      const w = (await getTileById("christmas-lapse")!.buildWhere(now)) as Record<string, unknown>;
      const or = w.OR as Array<{ lastOrderDate?: null | { lt: Date } }>;
      const cutoff = or.find((o) => o.lastOrderDate && typeof o.lastOrderDate === "object");
      const cutoffDate = (cutoff!.lastOrderDate as { lt: Date }).lt;
      expect(cutoffDate.getUTCFullYear()).toBe(2026);
      expect(cutoffDate.getUTCMonth()).toBe(8); // September (0-indexed)
      expect(cutoffDate.getUTCDate()).toBe(1);
    });
  });

  describe("buildMissingPiecesWhere", () => {
    const now = new Date("2026-06-15T12:00:00Z");

    it("returns an empty set when there are no active pairings", () => {
      const w = buildMissingPiecesWhere([], now) as { id: { in: number[] } };
      expect(w.id).toEqual({ in: [] });
    });

    it("produces one OR clause per pairing", () => {
      const pairings: PairingRule[] = [
        {
          fromDepartmentId: 5,
          fromCategoryId: null,
          toDepartmentId: 9,
          toCategoryId: null,
          windowDays: 60,
        },
        {
          fromDepartmentId: 3,
          fromCategoryId: 44,
          toDepartmentId: 15,
          toCategoryId: 99,
          windowDays: 90,
        },
      ];
      const w = buildMissingPiecesWhere(pairings, now) as { OR: unknown[] };
      expect(w.OR).toHaveLength(2);
    });

    it("each clause requires a From purchase in-window AND no To purchase ever", () => {
      const p: PairingRule = {
        fromDepartmentId: 5,
        fromCategoryId: null,
        toDepartmentId: 9,
        toCategoryId: null,
        windowDays: 60,
      };
      const w = buildMissingPiecesWhere([p], now) as {
        OR: Array<{ salesOrders: unknown; NOT: unknown }>;
      };
      const clause = w.OR[0];
      expect(clause).toHaveProperty("salesOrders");
      expect(clause).toHaveProperty("NOT");
      // In-window guard 60 days back
      const orderFilter = (clause.salesOrders as { some: { orderDate: { gte: Date } } }).some
        .orderDate.gte;
      expect(orderFilter.getTime()).toBe(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    });

    it("narrows by category when fromCategoryId or toCategoryId is set", () => {
      const p: PairingRule = {
        fromDepartmentId: 5,
        fromCategoryId: 17,
        toDepartmentId: 9,
        toCategoryId: 22,
        windowDays: 60,
      };
      const w = buildMissingPiecesWhere([p], now) as {
        OR: Array<{
          salesOrders: { some: { lineItems: { some: { product: Record<string, number> } } } };
          NOT: {
            salesOrders: {
              some: { lineItems: { some: { product: Record<string, number> } } };
            };
          };
        }>;
      };
      const fromProduct = w.OR[0].salesOrders.some.lineItems.some.product;
      const toProduct = w.OR[0].NOT.salesOrders.some.lineItems.some.product;
      expect(fromProduct.departmentId).toBe(5);
      expect(fromProduct.categoryId).toBe(17);
      expect(toProduct.departmentId).toBe(9);
      expect(toProduct.categoryId).toBe(22);
    });
  });
});
