// /app/src/pages/api/admin/buyer-drafts/buys/[id]/performance.ts
//
// Slice 6 (2026-05-12) — Buy performance report endpoint.
//
// For one Buy, returns:
//   1. The Buy header (name/season/year/status/budget)
//   2. Per-frame metrics (qtyOrdered, qtySold, revenue, margin, etc.)
//   3. Header rollups (totalSpent, totalRevenue, marginPct, …)
//   4. The compare-to candidate (same season, prior year) — just the id +
//      header; the UI fetches the comparable's full performance via a
//      second call so this endpoint stays focused.
//
// Excludes Marjan products (consignment with no shared frame stems —
// see user direction 2026-05-12).
//
// ADMIN-only. GET only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildFrameDecisions, type FrameInput } from "@/lib/frameRollup";
import {
  computePerformance,
  type PerformanceDraft,
  type PerformanceSaleLine,
  type PerformanceReceiptLine,
  type ProductFrameIndex,
} from "@/lib/buyPerformance";
import { deriveSalesWindow, type BuyPoForWindow } from "@/lib/buyPerformanceWindow";
import { computeBuyLinkCutoff } from "@/lib/buyerDraftBuyLinkCutoff";

const MARJAN_VENDOR_NAMES = ["Marjan", "Marjan International Corp"];

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const id = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    // 1) The Buy + its drafts (including the linked Product and that
    // Product's vendor — needed for frame-rollup classification + Marjan
    // exclusion).
    const buy = await prisma.buyerDraftBuy.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        season: true,
        year: true,
        status: true,
        budget: true,
        kickoff: true,
        created: true,
        pos: {
          select: {
            id: true,
            // Slice 6.2 — pull ETA fields so deriveSalesWindow can anchor
            // the sales window. expectedShipMonth is "YYYY-MM"; precise
            // expectedDeliveryDate wins when both are set on a PO.
            expectedShipMonth: true,
            expectedDeliveryDate: true,
            // Slice 6.8 — vendorId on the draft PO lets us match against
            // real ReceivingRecord rows (joined through PurchaseOrder)
            // so actualReceivedDate can anchor the sales window.
            vendorId: true,
            // Slice 6.14 (2026-05-22) — M:N links to real POs. Replaces
            // the prior 1:1 importedFromPurchaseOrderId field. Drives
            // the explicit-link precedence (when set, the empirical
            // productId join is skipped).
            realPoLinks: { select: { realPoId: true } },
            items: {
              select: {
                id: true,
                qty: true,
                cost: true,
                retail: true,
                fulfilledProductId: true,
                vendorId: true,
                vendor: { select: { name: true } },
                fulfilledProduct: {
                  select: {
                    id: true,
                    productNumber: true,
                    vendorId: true,
                    vendor: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!buy) return res.status(404).json({ error: "Buy not found" });

    // 2) Build frame decisions for the linked Products we have.
    // Drafts without a linked Product can't participate in rollup yet —
    // they show as "no-link" status.
    const draftRows = buy.pos.flatMap((p) => p.items);

    // We need to include FRAME-MATE products (other Products in
    // the same vendor's catalog that share a frame stem) so that sales
    // of variants count toward the same frame. Pull the vendor's full
    // product universe for any linked vendor. The classification works
    // off the full set; per-draft linkage is checked separately below.
    const linkedVendorIds = Array.from(
      new Set(
        draftRows
          .map((d) => d.fulfilledProduct?.vendorId)
          .filter((v): v is number => v !== undefined && v !== null),
      ),
    );

    const allVendorProducts =
      linkedVendorIds.length === 0
        ? []
        : await prisma.product.findMany({
            where: {
              vendorId: { in: linkedVendorIds },
              vendor: { name: { notIn: MARJAN_VENDOR_NAMES } },
            },
            select: { id: true, productNumber: true, vendorId: true },
          });

    const frameInputs: FrameInput[] = allVendorProducts.map((p) => ({
      productId: p.id,
      productNumber: p.productNumber ?? null,
      vendorId: p.vendorId,
    }));

    const frameDecisions = buildFrameDecisions(frameInputs, true);

    // Build the ProductFrameIndex (productId -> frameKey)
    const productToFrame: ProductFrameIndex = new Map(
      Array.from(frameDecisions.entries()).map(([pid, dec]) => [pid, dec.frameKey]),
    );

    // 3) Build the draft rows with frame attribution
    const drafts: PerformanceDraft[] = draftRows
      .filter((d) => {
        const vendorName = d.fulfilledProduct?.vendor?.name ?? d.vendor?.name ?? "";
        return !MARJAN_VENDOR_NAMES.includes(vendorName);
      })
      .map((d) => {
        const frame =
          d.fulfilledProductId === null ? null : (frameDecisions.get(d.fulfilledProductId) ?? null);
        return {
          draftId: d.id,
          qty: d.qty,
          costPerUnit: Number(d.cost.toString()),
          retailPerUnit: Number(d.retail.toString()),
          fulfilledProductId: d.fulfilledProductId,
          frameKey: frame?.frameKey ?? null,
          frameLabel: frame?.frameLabel ?? "(no link yet)",
        };
      });

    // 3.5) Slice 6.2/6.8 — derive the sales window. Precedence:
    //   actualReceivedDate > expectedDeliveryDate > expectedShipMonth >
    //   fallback-full-history. The actual receivedDate is queried below
    //   from receivings on the linked-real-PO set (see step 3.6).
    const productIdsInScope = Array.from(productToFrame.keys());

    // 3.6) Slice 6.8 — load receiving data SCOPED TO THE LINKED REAL POs.
    // User feedback 2026-05-14: the previous implementation pulled
    // every ReceivingRecord for products in scope, regardless of which
    // PO they were on. That gave qtyReceived an all-time count
    // (years of catalog receivings for the same product appeared) AND
    // anchored the sales window to an ancient receivedDate, making
    // qtySold effectively all-time too.
    //
    // Fix: scope receivings to the real POs that the linked-POs panel
    // (slice 6.7) identifies as covering this buy — i.e., POs with at
    // least one line whose productId matches a draft's
    // fulfilledProductId. Both qtyReceived and actualReceivedDate are
    // now bounded to receivings on THESE PONs only. Same productId
    // join used by `lib/buyerDraftRealPoLink.ts`.
    // Resolve the buy's real-PO scope. Extracted helper because the
    // explicit-vs-empirical branching pushed the handler's cognitive
    // complexity over the threshold; see resolveLinkedPoScope below.
    const scope = await resolveLinkedPoScope(buy, productIdsInScope);
    const { linkedRealPoIds, draftPoToLinkedPoIds } = scope;
    const { receipts, earliestReceivedByPoId, earliestReceivedByProductId } =
      await loadReceivings(linkedRealPoIds);
    const posForWindow: BuyPoForWindow[] = buy.pos.map((p) => ({
      expectedShipMonth: p.expectedShipMonth ?? null,
      expectedDeliveryDate: p.expectedDeliveryDate ?? null,
      actualReceivedDate: earliestReceivedDateForDraftPo(
        draftPoToLinkedPoIds.get(p.id) ?? new Set(),
        earliestReceivedByPoId,
      ),
    }));
    const salesWindow = deriveSalesWindow({ pos: posForWindow, now: new Date() });

    // 4) Pull sales for every product in any frame we're tracking. Apply
    // the window's start as a gte on salesOrder.orderDate when set.
    // Bug-fix 2026-05-13 (user-reported): the prior filter `not: "CANCELLED"`
    // included QUOTE-status orders. Quotes are NOT sales — they're open
    // proposals that may or may not convert. WH-660 was reporting 31
    // sold for the Spring 2026 buy; net of quotes the real number is
    // 12. We follow the canonical `detailed-sales.ts` filter:
    // `status: { in: ["ORDER", "FULFILLED", "RETURNED"] }`. Returns
    // STAY in (their negative qty subtracts net-sold correctly).
    const SOLD_STATUSES = ["ORDER", "FULFILLED", "RETURNED"] as const;
    const saleLines =
      productIdsInScope.length === 0
        ? []
        : await prisma.orderLineItem.findMany({
            where: {
              productId: { in: productIdsInScope },
              lineItemStatus: { not: "CANCELLED" },
              salesOrder:
                salesWindow.start === null
                  ? { status: { in: [...SOLD_STATUSES] } }
                  : {
                      status: { in: [...SOLD_STATUSES] },
                      orderDate: { gte: salesWindow.start },
                    },
            },
            select: {
              productId: true,
              orderedQuantity: true,
              netPrice: true,
              cost: true,
              // Phase 6.8.1 — orderDate for per-frame window filtering
              // in `computePerformance`. The buy-wide gte filter above
              // is the broad SQL scope; the helper tightens each frame
              // to its OWN earliest receivedDate from the linked POs.
              salesOrder: { select: { orderDate: true } },
            },
          });

    const sales: PerformanceSaleLine[] = saleLines.map((s) => ({
      productId: s.productId!,
      qty: Number(s.orderedQuantity.toString()),
      netPrice: Number(s.netPrice.toString()),
      cost: s.cost === null ? null : Number(s.cost.toString()),
      orderDate: s.salesOrder?.orderDate ?? null,
    }));

    // 5) Compute. daysSinceBuyExported = days since buy.created. Could
    // refine to use a per-draft exportedAt timestamp in a later iteration.
    const daysSinceBuyExported = Math.max(
      0,
      Math.floor((Date.now() - buy.created.getTime()) / (24 * 60 * 60 * 1000)),
    );

    // Phase 6.3 (2026-05-13) — STOCK product set = the buyer's drafted
    // (linked) products for this Buy. Sales of these productIds count
    // as STOCK sold (came off the planned shelf); other frame-mate
    // variant sales count as SPECIAL orders. Status logic uses STOCK
    // sell-through only — special orders don't consume inventory.
    const stockProductIds = new Set<number>(
      drafts
        .map((d) => d.fulfilledProductId)
        .filter((id): id is number => id !== null && id !== undefined),
    );

    // Phase 6.8.1 — build the per-frame sales window map from the
    // linked-PO receipts. For each frame, the window starts at the
    // EARLIEST receivedDate of any of its products. Frames not
    // received yet are absent from the map → no per-frame filter
    // (the buy-wide SQL window still bounds them).
    const frameWindowStartByKey = buildFrameWindowStartByKey(
      earliestReceivedByProductId,
      productToFrame,
    );

    const rows = computePerformance(
      drafts,
      sales,
      productToFrame,
      {
        daysSinceBuyExported,
        stockProductIds,
        frameWindowStartByKey,
      },
      receipts,
    );

    // 6) Header rollups
    const totalSpent = rows.reduce((acc, r) => acc + r.totalCost, 0);
    const totalRevenue = rows.reduce((acc, r) => acc + r.revenue, 0);
    const totalCostOfSold = rows.reduce((acc, r) => acc + r.costOfSold, 0);
    const totalGrossProfit = Math.max(0, totalRevenue - totalCostOfSold);
    const overallMargin = totalRevenue === 0 ? 0 : totalGrossProfit / totalRevenue;
    const totalQtyOrdered = rows.reduce((acc, r) => acc + r.qtyOrdered, 0);
    const totalQtyReceived = rows.reduce((acc, r) => acc + r.qtyReceived, 0);
    const totalQtyStockReceived = rows.reduce((acc, r) => acc + r.qtyStockReceived, 0);
    const totalQtySpecialReceived = rows.reduce((acc, r) => acc + r.qtySpecialReceived, 0);
    const totalQtySold = rows.reduce((acc, r) => acc + r.qtySold, 0);
    const totalQtyStockSold = rows.reduce((acc, r) => acc + r.qtyStockSold, 0);
    const totalQtySpecialSold = rows.reduce((acc, r) => acc + r.qtySpecialSold, 0);
    const overallSellThrough = totalQtyOrdered === 0 ? 0 : totalQtySold / totalQtyOrdered;
    const overallStockSellThrough = totalQtyOrdered === 0 ? 0 : totalQtyStockSold / totalQtyOrdered;

    // 7) Find the compare-to candidate (same season, prior year, ADMIN-visible)
    const compareToCandidate =
      buy.season && buy.year
        ? await prisma.buyerDraftBuy.findFirst({
            where: {
              season: buy.season,
              year: { lt: buy.year },
              id: { not: buy.id },
            },
            orderBy: { year: "desc" },
            select: { id: true, name: true, year: true, season: true },
          })
        : null;

    return res.status(200).json({
      buy: {
        id: buy.id,
        name: buy.name,
        season: buy.season,
        year: buy.year,
        status: buy.status,
        budget: buy.budget?.toString() ?? null,
        daysSinceExported: daysSinceBuyExported,
      },
      rollup: {
        totalSpent,
        totalRevenue,
        totalGrossProfit,
        overallMargin,
        totalQtyOrdered,
        totalQtyReceived,
        totalQtyStockReceived,
        totalQtySpecialReceived,
        totalQtySold,
        totalQtyStockSold,
        totalQtySpecialSold,
        overallSellThrough,
        overallStockSellThrough,
      },
      frames: rows,
      compareTo: compareToCandidate,
      salesWindow: {
        start: salesWindow.start === null ? null : salesWindow.start.toISOString(),
        end: salesWindow.end.toISOString(),
        source: salesWindow.source,
        message: salesWindow.message,
      },
    });
  } catch (err) {
    logError("buyer-drafts buy performance failed", err);
    return res.status(500).json({ error: "Failed to compute performance" });
  }
});

// Slice 6.8 (revised 2026-05-14 per user feedback) — load receivings
// SCOPED to a specific set of real PO ids.
//
// Previously this scoped by productId only, which gave qtyReceived an
// all-time count (catalog products receive across many buys; a single
// product might have years of receivings unrelated to THIS buy).
// Anchor for actualReceivedDate was similarly skewed back too far,
// making the sales window effectively "all time."
//
// Fix: caller computes the linked-real-PO set first (via productId
// match — same logic the linked-POs panel uses), then this query is
// bounded by those real PO ids. Both qtyReceived and the per-PO
// earliest receivedDate now reflect only the buy's actual coverage.
async function loadReceivings(linkedRealPoIds: readonly number[]): Promise<{
  receipts: PerformanceReceiptLine[];
  earliestReceivedByPoId: Map<number, Date>;
  earliestReceivedByProductId: Map<number, Date>;
}> {
  if (linkedRealPoIds.length === 0) {
    return {
      receipts: [],
      earliestReceivedByPoId: new Map(),
      earliestReceivedByProductId: new Map(),
    };
  }
  const rows = await prisma.receivingRecord.findMany({
    where: { purchaseOrderId: { in: [...linkedRealPoIds] } },
    select: {
      purchaseOrderId: true,
      receivedDate: true,
      quantityReceived: true,
      purchaseOrderItem: {
        select: { productId: true },
      },
    },
  });

  const receipts: PerformanceReceiptLine[] = rows.flatMap((r) => {
    const pid = r.purchaseOrderItem?.productId;
    if (pid === null || pid === undefined) return [];
    return [{ productId: pid, qty: Number(r.quantityReceived.toString()) }];
  });

  // Per-PO earliest receivedDate. The window anchor caller picks the
  // earliest across the draft PO's linked real POs (per-draft-PO).
  const earliestReceivedByPoId = new Map<number, Date>();
  // Phase 6.8.1 — per-productId earliest receivedDate. Lets the helper
  // gate each frame's sales by that frame's actual arrival date.
  const earliestReceivedByProductId = new Map<number, Date>();
  for (const r of rows) {
    const date = r.receivedDate;
    if (date === null) continue;
    const existingPo = earliestReceivedByPoId.get(r.purchaseOrderId);
    if (existingPo === undefined || date < existingPo) {
      earliestReceivedByPoId.set(r.purchaseOrderId, date);
    }
    const pid = r.purchaseOrderItem?.productId;
    if (pid !== null && pid !== undefined) {
      const existingProd = earliestReceivedByProductId.get(pid);
      if (existingProd === undefined || date < existingProd) {
        earliestReceivedByProductId.set(pid, date);
      }
    }
  }

  return { receipts, earliestReceivedByPoId, earliestReceivedByProductId };
}

// Phase 6.8.1 — roll up product-level receivedDate into frame-level
// receivedDate by taking the EARLIEST across all of a frame's
// products. "When did any variant of this frame first show up in
// our warehouse?" — that's the start of valid sales attribution for
// the frame. Pure helper, easy to reason about.
function buildFrameWindowStartByKey(
  earliestReceivedByProductId: ReadonlyMap<number, Date>,
  productToFrame: ReadonlyMap<number, string>,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const [productId, date] of earliestReceivedByProductId) {
    const frameKey = productToFrame.get(productId);
    if (frameKey === undefined) continue;
    const existing = out.get(frameKey);
    if (existing === undefined || date < existing) {
      out.set(frameKey, date);
    }
  }
  return out;
}

// Slice 6.8.2 (2026-05-15) — productId-only matching pulled in historical
// real POs that happened to share a productId but were placed years before
// this Buy existed. For Spring 2026 (created 2026-05-09), 71 real POs
// matched via productId; the earliest was 2023-04-11. That gave qtyReceived
// an all-time count and anchored the sales window to "since 2023" instead
// of "since this buy was received." Both symptoms surfaced as wrong
// numbers on the Buy performance page.
//
// Fix: bound the productId match by `orderDate` via `computeBuyLinkCutoff`
// in `lib/buyerDraftBuyLinkCutoff.ts`. See that module's header for the
// rationale and the fallback chain.

// Slice 6.14 (2026-05-22) — when the buy has explicit M:N links to
// real POs (via BuyerDraftPoRealPoLink), build the per-draft-PO map
// directly from those links. Each draft PO can now have N real POs
// linked (forward-flow auto-link, manual operator links, historical
// imports — all use the same join table).
function buildExplicitDraftPoMap(
  draftPos: ReadonlyArray<{ id: number; realPoLinks: ReadonlyArray<{ realPoId: number }> }>,
): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const p of draftPos) {
    if (p.realPoLinks.length > 0) {
      out.set(p.id, new Set(p.realPoLinks.map((l) => l.realPoId)));
    }
  }
  return out;
}

// Resolve the buy's real-PO scope: when explicit Slice 6.14 links
// exist they're authoritative; otherwise fall through to the
// empirical productId join with the (now 3-month) date cutoff.
// Extracted from the main handler 2026-05-22 to keep handler CC under
// 15 per Sonar S3776.
interface LinkedPoScopeResult {
  linkedRealPoIds: number[];
  draftPoToLinkedPoIds: Map<number, Set<number>>;
}

async function resolveLinkedPoScope(
  buy: {
    id: number;
    created: Date;
    pos: ReadonlyArray<{
      id: number;
      expectedShipMonth: Date | null;
      realPoLinks: ReadonlyArray<{ realPoId: number }>;
    }>;
  },
  productIdsInScope: readonly number[],
): Promise<LinkedPoScopeResult> {
  const explicitRealPoIds = new Set(buy.pos.flatMap((p) => p.realPoLinks.map((l) => l.realPoId)));
  if (explicitRealPoIds.size > 0) {
    return {
      linkedRealPoIds: Array.from(explicitRealPoIds),
      draftPoToLinkedPoIds: buildExplicitDraftPoMap(buy.pos),
    };
  }
  const orderDateCutoff = computeBuyLinkCutoff(buy.pos, buy.created, 3);
  const [linkedRealPoIds, draftPoToLinkedPoIds] = await Promise.all([
    findLinkedRealPoIds(productIdsInScope, orderDateCutoff),
    mapDraftPoToLinkedRealPos(buy.id, orderDateCutoff),
  ]);
  return { linkedRealPoIds, draftPoToLinkedPoIds };
}

// Slice 6.8 — find the set of real PurchaseOrder ids that have at
// least one line matching any drafted product's `fulfilledProductId`,
// bounded by date so historical catalog noise doesn't slip in.
async function findLinkedRealPoIds(
  productIdsInScope: readonly number[],
  orderDateCutoff: Date | null,
): Promise<number[]> {
  if (productIdsInScope.length === 0) return [];
  const matchingLines = await prisma.purchaseOrderItem.findMany({
    where: {
      productId: { in: [...productIdsInScope] },
      purchaseOrder: orderDateCutoff ? { orderDate: { gte: orderDateCutoff } } : undefined,
    },
    select: { purchaseOrderId: true },
  });
  return Array.from(new Set(matchingLines.map((l) => l.purchaseOrderId)));
}

// Slice 6.8 — for each buyer-draft PO, find the set of real PO ids
// whose lines match any of THAT draft PO's drafted productIds.
// Per-draft-PO precision (vs. per-vendor in the previous design)
// stops a vendor's long catalog history from anchoring the window
// to ancient receivings unrelated to this specific draft PO. The
// orderDate cutoff (from `computeBuyLinkCutoff`) provides a second
// guard against productId-match noise from older buys.
async function mapDraftPoToLinkedRealPos(
  buyId: number,
  orderDateCutoff: Date | null,
): Promise<Map<number, Set<number>>> {
  // Pull each draft PO's drafted productIds.
  const draftRows = await prisma.buyerDraftItem.findMany({
    where: { draftPo: { buyId }, fulfilledProductId: { not: null } },
    select: { draftPoId: true, fulfilledProductId: true },
  });
  if (draftRows.length === 0) return new Map();

  // Collect every linked product → find real-PO lines that reference any.
  const allLinkedIds = Array.from(
    new Set(
      draftRows
        .map((d) => d.fulfilledProductId)
        .filter((v): v is number => v !== null && v !== undefined),
    ),
  );
  const lines = await prisma.purchaseOrderItem.findMany({
    where: {
      productId: { in: allLinkedIds },
      purchaseOrder: orderDateCutoff ? { orderDate: { gte: orderDateCutoff } } : undefined,
    },
    select: { productId: true, purchaseOrderId: true },
  });
  const realPoIdsByProductId = new Map<number, Set<number>>();
  for (const l of lines) {
    if (l.productId === null) continue;
    const set = realPoIdsByProductId.get(l.productId) ?? new Set<number>();
    set.add(l.purchaseOrderId);
    realPoIdsByProductId.set(l.productId, set);
  }

  // For each draft PO, union the real PO sets across its products.
  const out = new Map<number, Set<number>>();
  for (const d of draftRows) {
    if (d.draftPoId === null || d.fulfilledProductId === null) continue;
    const realIds = realPoIdsByProductId.get(d.fulfilledProductId);
    if (!realIds) continue;
    const acc = out.get(d.draftPoId) ?? new Set<number>();
    for (const r of realIds) acc.add(r);
    out.set(d.draftPoId, acc);
  }
  return out;
}

// Slice 6.8 — pick the earliest receivedDate among a draft PO's
// linked real POs. Returns null when the draft PO has no linked
// receivings yet (the helper falls back to planned dates).
function earliestReceivedDateForDraftPo(
  linkedRealPoIds: Set<number>,
  earliestReceivedByPoId: Map<number, Date>,
): Date | null {
  let earliest: Date | null = null;
  for (const realPoId of linkedRealPoIds) {
    const d = earliestReceivedByPoId.get(realPoId);
    if (d === undefined) continue;
    if (earliest === null || d < earliest) earliest = d;
  }
  return earliest;
}
