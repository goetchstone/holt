// /app/src/server/trpc/routers/legacyArchive.ts
//
// Legacy Archive lookup (feature flag `legacyArchive`). Read-only by design —
// one search procedure, any signed-in staff (parity with the rest of the
// Tools hub). Empty searches return only the archive meta (no full-table
// scan); matches come back with lines nested for the expandable cards.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { router, protectedProcedure } from "../trpc";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { buildLegacyArchiveWhere, LEGACY_ARCHIVE_PAGE_SIZE } from "@/lib/legacyArchive";

async function requireArchiveEnabled(): Promise<void> {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "legacyArchive")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Legacy archive is not enabled." });
  }
}

export const legacyArchiveRouter = router({
  search: protectedProcedure
    .input(
      z.object({
        search: z.string().max(200),
        page: z.number().int().min(1).max(100000).default(1),
      }),
    )
    .query(async ({ input }) => {
      await requireArchiveEnabled();

      const [archiveOrders, bounds] = await Promise.all([
        prisma.legacyOrder.count(),
        prisma.legacyOrder.aggregate({ _min: { saleDate: true }, _max: { saleDate: true } }),
      ]);
      const meta = {
        archiveOrders,
        earliest: bounds._min.saleDate?.toISOString() ?? null,
        latest: bounds._max.saleDate?.toISOString() ?? null,
      };

      const term = input.search.trim();
      if (term.length === 0) {
        return { orders: [], total: 0, page: 1, pageSize: LEGACY_ARCHIVE_PAGE_SIZE, meta };
      }

      const where = buildLegacyArchiveWhere(term);
      const [total, rows] = await Promise.all([
        prisma.legacyOrder.count({ where }),
        prisma.legacyOrder.findMany({
          where,
          orderBy: { saleDate: "desc" },
          skip: (input.page - 1) * LEGACY_ARCHIVE_PAGE_SIZE,
          take: LEGACY_ARCHIVE_PAGE_SIZE,
          include: { lines: { orderBy: { lineNumber: "asc" } } },
        }),
      ]);

      return {
        orders: rows.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          salesOrderNumber: o.salesOrderNumber,
          saleDate: o.saleDate?.toISOString() ?? null,
          customerCode: o.customerCode,
          customerName: o.customerName,
          companyName: o.companyName,
          email: o.email,
          phone: o.phone,
          phone2: o.phone2,
          address: o.address,
          city: o.city,
          state: o.state,
          zip: o.zip,
          grandTotal: o.grandTotal === null ? null : Number(o.grandTotal),
          taxTotal: o.taxTotal === null ? null : Number(o.taxTotal),
          lines: o.lines.map((l) => ({
            id: l.id,
            sku: l.sku,
            description: l.description,
            lineTotal: l.lineTotal === null ? null : Number(l.lineTotal),
            vendor: l.vendor,
            vendorSku: l.vendorSku,
            manufacturer: l.manufacturer,
            misc: [l.misc1, l.misc2, l.misc3, l.misc4, l.misc5]
              .filter((m): m is string => Boolean(m && m.trim()))
              .join(" · "),
          })),
        })),
        total,
        page: input.page,
        pageSize: LEGACY_ARCHIVE_PAGE_SIZE,
        meta,
      };
    }),
});
