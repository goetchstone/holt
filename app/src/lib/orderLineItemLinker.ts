// /app/src/lib/orderLineItemLinker.ts
//
// Backfill OrderLineItem.productId when a match can be found. Called
// automatically at the end of product imports, consignment syncs, AND every
// sales import so timing-issue mis-links self-heal as the catalog catches
// up. Can also be run manually from the admin maintenance page.
//
// TWO MODES (controlled by fixWrongLinks option):
//
// 1) BACKFILL MODE (default, fixWrongLinks=false): only touches line items
//    where productId IS NULL. Match order:
//      1. partNo equals Product.productNumber (the normal case).
//      2. partNo equals any Upc.upc linked to a Product (the POS often
//         sends the numeric UPC as the part number for HD blinds, etc.).
//      3. OrderLineItem.barcode equals any Upc.upc (fallback if partNo is
//         missing but barcode is set).
//
// 2) FIX-WRONG-LINKS MODE (fixWrongLinks=true): also re-links lines where
//    productId IS NOT NULL but a UPC match points to a DIFFERENT product.
//    Uses the same barcode/partNo→UPC→product lookup. Also syncs
//    `productName` to the new product's name (productName is denormalized
//    and read by the designer-credit report's filter — if we relink but
//    leave the old name stamped, downstream reports stay wrong).
//
//    Marjan-to-Marjan re-links are skipped. Per CLAUDE.md, the POS can
//    create multiple Product records for the same physical rug as it's
//    returned and re-consigned — those duplicates are intentional and we
//    must not collapse them.
//
// When multiple products match a line, picks the one with a department set,
// then the oldest id, so reports get a real category.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export interface RelinkOptions {
  // Restrict to line items whose partNo or barcode matches one of these
  // values. When omitted, scans all NULL-productId line items. Scope narrows
  // the scan when the caller knows what changed (e.g. just-imported product
  // numbers AND their UPCs).
  //
  // Important: include BOTH product numbers AND UPC barcodes here. A line
  // item may have partNo set to an the POS internal code that isn't in
  // this set yet its barcode matches one of the imported UPCs — if only
  // part numbers are passed, that line item is skipped.
  partNos?: string[];
  // Optional: only relink lines on orders in these statuses. Default excludes
  // CANCELLED lines (they don't matter for reports anyway).
  includeCancelledLines?: boolean;
  // When true, ALSO re-link lines where productId is already set but a UPC
  // match points to a different product. Default false (backfill-NULL-only,
  // backward compatible). Marjan-vendor lines are protected — see header.
  fixWrongLinks?: boolean;
}

export interface RelinkResult {
  updated: number;
  remainingUnlinked: number;
  partNosProcessed: number;
  wrongLinksFixed: number;
}

/**
 * Relink NULL-productId OrderLineItem rows to matching Product rows.
 *
 * Idempotent — running it repeatedly is a no-op after the first successful run
 * (no rows match the filter once linked). Safe to call after every product
 * import.
 */
export async function backfillLineItemProductLinks(
  opts: RelinkOptions = {},
  client: Pick<PrismaClient, "$executeRawUnsafe" | "orderLineItem"> = defaultPrisma,
): Promise<RelinkResult> {
  // Build the SQL. Separate paths for scoped (explicit partNos) vs full scan
  // so Postgres can use the productNumber index efficiently in both cases.

  const { partNos, includeCancelledLines, fixWrongLinks = false } = opts;

  const lineStatusClause = includeCancelledLines
    ? ""
    : 'AND (li."lineItemStatus" IS NULL OR li."lineItemStatus" <> \'CANCELLED\')';

  if (partNos && partNos.length === 0) {
    // Explicit empty array — nothing to do.
    return { updated: 0, remainingUnlinked: 0, partNosProcessed: 0, wrongLinksFixed: 0 };
  }

  // Scope clause — when caller passes partNos, restrict the candidate set.
  // partNos bound as a single $1 text[] param (reused across branches) — no
  // string interpolation of values into the SQL.
  const scopeFilter = partNos
    ? `AND (li2."partNo" = ANY($1::text[]) OR li2.barcode = ANY($1::text[]))`
    : "";
  const scopedLineStatus = lineStatusClause.replace(/li\./g, "li2.");

  // UNION ALL of three match strategies. DISTINCT ON (line_item_id) picks one
  // per line, preferring the row with `rank` = 1 (productNumber match), then
  // 2 (partNo == upc), then 3 (barcode == upc). Within a rank, prefer a
  // product with a department set and oldest id.
  //
  // 2026-05-16: also sets `productName` to the matched product's name when
  // the existing productName is NULL/empty. The old version only updated
  // productId — leaving productName blank — which broke the designer-credit
  // report's description column for any line linked by this helper (e.g.
  // SO-1678 line 3). Lines with an existing non-empty productName are
  // left alone (could be order-specific customization).
  const sql = `
    UPDATE "OrderLineItem" li
    SET "productId" = sub.picked_id,
        "productName" = CASE
          WHEN li."productName" IS NULL OR li."productName" = ''
            THEN sub.picked_name
          ELSE li."productName"
        END,
        updated = NOW()
    FROM (
      SELECT DISTINCT ON (line_item_id)
        line_item_id,
        picked_id,
        picked_name
      FROM (
        -- Strategy 1: partNo equals productNumber
        SELECT li2.id AS line_item_id, p.id AS picked_id, p.name AS picked_name,
               1 AS rank, (p."departmentId" IS NULL) AS no_dept
        FROM "OrderLineItem" li2
        JOIN "Product" p ON p."productNumber" = li2."partNo"
        WHERE li2."productId" IS NULL
          AND li2."partNo" IS NOT NULL
          AND li2."partNo" <> ''
          ${scopedLineStatus}
          ${scopeFilter}

        UNION ALL

        -- Strategy 2: partNo equals a UPC
        SELECT li2.id AS line_item_id, p.id AS picked_id, p.name AS picked_name,
               2 AS rank, (p."departmentId" IS NULL) AS no_dept
        FROM "OrderLineItem" li2
        JOIN "Upc" u ON u.upc = li2."partNo"
        JOIN "Product" p ON p.id = u."productId"
        WHERE li2."productId" IS NULL
          AND li2."partNo" IS NOT NULL
          AND li2."partNo" <> ''
          ${scopedLineStatus}
          ${scopeFilter}

        UNION ALL

        -- Strategy 3: OrderLineItem.barcode equals a UPC (fallback)
        SELECT li2.id AS line_item_id, p.id AS picked_id, p.name AS picked_name,
               3 AS rank, (p."departmentId" IS NULL) AS no_dept
        FROM "OrderLineItem" li2
        JOIN "Upc" u ON u.upc = li2.barcode
        JOIN "Product" p ON p.id = u."productId"
        WHERE li2."productId" IS NULL
          AND li2.barcode IS NOT NULL
          AND li2.barcode <> ''
          ${scopedLineStatus}
          ${scopeFilter}
      ) candidates
      ORDER BY line_item_id, rank ASC, no_dept ASC, picked_id ASC
    ) sub
    WHERE li.id = sub.line_item_id
  `;

  const updated = await client.$executeRawUnsafe(sql, ...(partNos ? [partNos] : []));

  // Phase 2: fix wrong-but-non-NULL links via UPC match. Same Marjan
  // exclusion as the one-shot 2026-05-15 migration. Re-links productId AND
  // syncs productName to the new product's name (the line's productName is
  // denormalized; if we don't sync, the designer-credit report's filter
  // keeps reading the stale "DELIVERY CHARGE" or whatever and still
  // excludes the corrected line).
  //
  // partNo and barcode on the line are preserved as the POS audit
  // trail (what came in via CSV).
  //
  // Idempotent: each pass either fixes a row or leaves it alone. No row
  // gets touched twice because once productId == upc-mapped productId,
  // the WHERE clause excludes it.
  let wrongLinksFixed = 0;
  if (fixWrongLinks) {
    const scopedFilter = partNos
      ? `AND (li."partNo" = ANY($1::text[]) OR li.barcode = ANY($1::text[]))`
      : "";
    const fixSql = `
      UPDATE "OrderLineItem" li
      SET "productId" = u."productId",
          "productName" = p_new.name,
          updated = NOW()
      FROM "Upc" u, "Product" p_old, "Product" p_new, "Vendor" v_old, "Vendor" v_new
      WHERE (u.upc = li.barcode OR u.upc = li."partNo")
        AND li."productId" IS NOT NULL
        AND li."productId" != u."productId"
        AND p_old.id = li."productId"
        AND p_new.id = u."productId"
        AND v_old.id = p_old."vendorId"
        AND v_new.id = p_new."vendorId"
        AND NOT (v_old.name ILIKE 'Marjan%' AND v_new.name ILIKE 'Marjan%')
        ${lineStatusClause}
        ${scopedFilter}
    `;
    wrongLinksFixed = await client.$executeRawUnsafe(fixSql, ...(partNos ? [partNos] : []));
  }

  const remainingUnlinked = await client.orderLineItem.count({
    where: {
      productId: null,
      partNo: { not: null },
      NOT: { partNo: "" },
      ...(includeCancelledLines ? {} : { lineItemStatus: { not: "CANCELLED" } }),
    },
  });

  logger.info("backfillLineItemProductLinks complete", {
    updated,
    wrongLinksFixed,
    remainingUnlinked,
    partNosScope: partNos?.length ?? "all",
    fixWrongLinks,
  });

  return {
    updated,
    wrongLinksFixed,
    remainingUnlinked,
    partNosProcessed: partNos?.length ?? 0,
  };
}
