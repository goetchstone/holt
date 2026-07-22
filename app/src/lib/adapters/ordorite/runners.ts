// /app/src/lib/adapters/ordorite/runners.ts
//
// Standalone import runner functions extracted from the API handlers.
// Each function accepts a parsed data array and a createdBy identifier,
// returning a results object. Used by both the manual API handlers and
// the automated Gmail import orchestrator.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import {
  safeString,
  safeFloat,
  safeDate,
  findOrCreateCustomer,
  isUntrustedMergeEmail,
  normalizeEmail,
  parseOrdoriteAddress,
  parseTaxLabel,
  resolveTaxDistrictId,
  resolveTaxExemptReasonId,
  deriveSalesOrderStatus,
  findProduct,
  parseDateFlexible,
  derivePOStatus,
  resolvePaymentMode,
  isRefundPayment,
  isRewriteOrder,
  rewriteBaseOrderno,
  classifyPOReceiptStatus,
  ensureUnknownVendorId,
} from "@/lib/adapters/ordorite/shared";
import { buildLocationMap } from "@/lib/storeLocationResolver";
import { syncConsignmentReturns } from "@/lib/paymentService";
import {
  isMarjanRug,
  toMarjanBarcode,
  toMarjanCustomerNumber,
  findWashedRugCustomerNumbers,
} from "@/lib/consignment";
import { findDroppedBaseLineIds } from "@/lib/adapters/ordorite/sameDayRewriteCleanup";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";
import { getCellValue } from "@/lib/excelUtils";
import { backfillSalesPersonFk } from "@/lib/salesPersonFkBackfill";
import { loadActiveConfirmationsWithNames } from "@/lib/payPeriodLockGuard";
import { isOrderLockedByNameOrFk } from "@/lib/payPeriodLock";
import { planAutoLinks, type DraftCandidate, type UpcIndex } from "@/lib/buyerDraftAutoLink";
import { planAutoFulfill, type DraftPoForAutoFulfill } from "@/lib/buyerDraftAutoFulfillPo";
import { planPoAutoLinks } from "@/lib/buyerDraftPoAutoLink";
import { logger, logError } from "@/lib/logger";

const BATCH_SIZE = 50;

// ReceivingRecord.receiverUserId is a FK to User.id (CUID string), not
// the user's email. Look up the User by email; if none exists yet (the
// automation user, or a freshly OAuthed admin who hasn't had a User row
// created yet via NextAuth), find or create a placeholder so the FK
// always resolves to a real row. Cached for the lifetime of a single
// runner invocation since it's the same email throughout.
const resolveImportUserIdCache = new Map<string, string>();

// Test-only: module caches survive across resetTestDb() TRUNCATEs and would
// otherwise hand out ids of rows that no longer exist.
export function clearImportRunnerCachesForTesting(): void {
  resolveImportUserIdCache.clear();
}
async function resolveImportUserId(email: string): Promise<string> {
  const key = (email || "").toLowerCase();
  const cached = resolveImportUserIdCache.get(key);
  if (cached) return cached;

  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    // The "auto-import" sentinel isn't a real email. Park imports under
    // a single placeholder User row so the FK is always satisfied.
    const placeholderEmail = email.includes("@") ? email : "import-runner@holt.local";
    user = await prisma.user.upsert({
      where: { email: placeholderEmail },
      update: {},
      create: {
        email: placeholderEmail,
        name: email,
      },
      select: { id: true },
    });
  }
  resolveImportUserIdCache.set(key, user.id);
  return user.id;
}

// ---------------------------------------------------------------------------
// Sales import
// ---------------------------------------------------------------------------

export interface SalesImportResult {
  salesOrdersCreated: number;
  salesOrdersUpdated: number;
  returnsDetected: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  poLinksCreated: number;
  consignmentItemsSynced: number;
  /**
   * Base-order line items cancelled by the same-day rewrite cleanup
   * (post-failure log 2026-05-12, Cheshire $1,109 delta). Optional —
   * only set when cleanup actually ran.
   */
  sameDayRewriteLinesCancelled?: number;
  /**
   * Lines linked to a product (productId set) by the post-import
   * backfillLineItemProductLinks sweep — typically prior-import lines
   * whose UPC has now arrived in our catalog. Optional.
   */
  lineItemsLinked?: number;
  /**
   * Lines RE-linked because their existing (wrong) productId differed
   * from what the UPC says. Optional. Marjan-to-Marjan dups are excluded.
   */
  lineItemsRelinked?: number;
  /**
   * SalesOrders whose `salesPersonId` FK was set by the post-import
   * sweep (resolved from `salesperson` string via StaffMember
   * displayName + aliases). Optional — only present when > 0.
   * Origin: Issue #274 follow-up, ROADMAP Short-Term #12.
   */
  salesPersonFkBackfilled?: number;
  errors: string[];
}

export async function runSalesImport(
  salesData: Record<string, unknown>[],
  createdBy?: string,
): Promise<SalesImportResult> {
  const results: SalesImportResult = {
    salesOrdersCreated: 0,
    salesOrdersUpdated: 0,
    returnsDetected: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    poLinksCreated: 0,
    consignmentItemsSynced: 0,
    errors: [],
  };

  // Group line items by order number
  const ordersMap = new Map<string, Record<string, unknown>[]>();
  for (const row of salesData) {
    const orderno = safeString(row.Orderno);
    if (orderno) {
      if (!ordersMap.has(orderno)) ordersMap.set(orderno, []);
      ordersMap.get(orderno)!.push(row);
    } else {
      results.errors.push("Skipped row: missing Orderno");
    }
  }

  // Pre-load existing orders. Include salesPersonId so we can detect orders
  // that have been manually corrected (via split import or salesperson edit)
  // and avoid overwriting the corrected salesperson string.
  const orderNumbers = Array.from(ordersMap.keys());
  const existingOrders = await prisma.salesOrder.findMany({
    where: { orderno: { in: orderNumbers } },
    select: {
      id: true,
      orderno: true,
      salesPersonId: true,
      splitWithId: true,
      salesperson: true,
      orderDate: true,
    },
  });
  const existingOrderMap = new Map(existingOrders.map((o) => [o.orderno, o.id]));
  const correctedOrders = new Set(
    existingOrders.filter((o) => o.salesPersonId !== null).map((o) => o.orderno),
  );

  // Pay-period attribution lock: any existing order dated in a
  // confirmed (active) period for its current designer must keep its
  // salesperson attribution — the import must not re-write it from
  // the CSV. This is the enforcement that prevents the nightly import
  // from silently re-attributing a locked period ("bad numbers like
  // David's"). Matches by NAME or FK (not just FK) because the FK is
  // often NULL until the post-import backfill sweep resolves it. See
  // docs/domains/commission.md.
  const activeConfirmations = await loadActiveConfirmationsWithNames();
  const lockedOrders = new Set(
    existingOrders
      .filter((o) => isOrderLockedByNameOrFk(o, activeConfirmations))
      .map((o) => o.orderno),
  );

  // Pre-load barcodes -> products
  const allBarcodes = new Set<string>();
  for (const rows of ordersMap.values()) {
    for (const row of rows) {
      const bc = safeString(row["Barcode No"]);
      if (bc) allBarcodes.add(bc.toLowerCase());
    }
  }
  const upcRecords =
    allBarcodes.size > 0
      ? await prisma.upc.findMany({
          where: { upc: { in: Array.from(allBarcodes), mode: "insensitive" } },
          select: {
            upc: true,
            product: { select: { id: true, name: true, productNumber: true } },
          },
        })
      : [];
  const barcodeProductMap = new Map<string, { id: number; name: string; productNumber: string }>();
  for (const u of upcRecords) {
    barcodeProductMap.set(u.upc.toLowerCase(), u.product);
  }

  const locationMap = await buildLocationMap();
  const taxDistrictCache = new Map<string, number | null>();

  const orderEntries = Array.from(ordersMap.entries());
  for (let batchStart = 0; batchStart < orderEntries.length; batchStart += BATCH_SIZE) {
    const batch = orderEntries.slice(batchStart, batchStart + BATCH_SIZE);

    // Collect product numbers for returned orders so consignment items can be
    // reverted after the transaction commits (syncConsignmentReturns uses the
    // module-level prisma client, not tx).
    const returnedLineItems: { productNumber: string }[] = [];

    // Collect sold Marjan rug info so consignment items can be marked SOLD.
    const soldRugOrders: {
      salesOrderId: number;
      rugMatches: { barcode: string | null; customerNumber: string | null }[];
      orderDate: Date;
    }[] = [];

    await prisma.$transaction(async (tx) => {
      for (const [orderno, orderLines] of batch) {
        try {
          const firstRow = orderLines[0];
          const cuscode = safeString(firstRow.Cuscode);
          const customerName = safeString(firstRow.Customer);

          const customer = await findOrCreateCustomer(tx as never, {
            cuscode,
            customerName,
            email: normalizeEmail(firstRow.Email) || undefined,
            createdBy,
          });

          const notesSet = new Set<string>();
          for (const row of orderLines) {
            const note = safeString(row.ordernotes);
            if (note) notesSet.add(note);
          }
          const combinedNotes = notesSet.size > 0 ? [...notesSet].join(" | ") : undefined;

          const vatRateRaw = safeFloat(firstRow.Vatrate);
          let taxDistrictId: number | null = null;
          if (vatRateRaw > 0) {
            const cacheKey = `CT-${vatRateRaw}`;
            if (taxDistrictCache.has(cacheKey)) {
              taxDistrictId = taxDistrictCache.get(cacheKey)!;
            } else {
              const parsed = parseTaxLabel(`CT ${(vatRateRaw * 100).toFixed(2)}%`);
              taxDistrictId = await resolveTaxDistrictId(tx as never, parsed);
              taxDistrictCache.set(cacheKey, taxDistrictId);
            }
          }

          const storeLocationStr = safeString(firstRow.Company);
          const statusField = safeString(firstRow.Status) || safeString(firstRow.Orderstatus);
          const status = deriveSalesOrderStatus(orderno, orderLines, statusField);

          if (status === "CANCELLED") {
            results.returnsDetected++;
          }

          if (status === "RETURNED") {
            results.returnsDetected++;
            // Collect product numbers so consignment rugs can be reverted after commit
            for (const row of orderLines) {
              const bc = safeString(row["Barcode No"]);
              const product = bc ? barcodeProductMap.get(bc.toLowerCase()) : null;
              // Use product number if available, otherwise fall back to the raw barcode.
              // Marjan rugs may not be imported as products but their barcode is sufficient.
              const rugCandidate = product?.productNumber ?? bc;
              if (isMarjanRug(rugCandidate)) {
                returnedLineItems.push({ productNumber: toMarjanBarcode(rugCandidate!) });
              }
            }
          }

          const ordoriteSalesperson = safeString(firstRow.Salesperson);

          // Don't downgrade status: if an order is already FULFILLED or RETURNED,
          // the daily sales CSV doesn't know that — it would revert to ORDER.
          // Only allow status changes that are promotions or explicit returns/cancels.
          const existingOrder = existingOrderMap.has(orderno)
            ? await tx.salesOrder.findUnique({
                where: { orderno },
                select: { status: true },
              })
            : null;
          const existingStatus = existingOrder?.status;
          const shouldKeepStatus =
            existingStatus === "FULFILLED" ||
            existingStatus === "CANCELLED" ||
            (existingStatus === "RETURNED" && status === "ORDER");
          const effectiveStatus = shouldKeepStatus ? existingStatus : status;

          const orderData = {
            orderDate: safeDate(firstRow.Orderdate) || new Date(),
            status: effectiveStatus,
            customerId: customer?.id,
            externalCustomerCode: cuscode || undefined,
            salesperson: ordoriteSalesperson,
            storeLocation: storeLocationStr,
            storeLocationId: locationMap.get(storeLocationStr?.toLowerCase() ?? "") ?? undefined,
            orderNotes: combinedNotes,
            taxDistrictId,
          };

          // If the order has a salesPersonId, its salesperson attribution has
          // been manually corrected (split import, reassignment, etc.). Ordorite
          // does not track splits, so its salesperson field would overwrite the
          // corrected value. Preserve the correction by omitting salesperson
          // from the update.
          const isCorrected = correctedOrders.has(orderno) || lockedOrders.has(orderno);
          const updateData = isCorrected ? { ...orderData, salesperson: undefined } : orderData;

          const isExisting = existingOrderMap.has(orderno);
          const salesOrder = await tx.salesOrder.upsert({
            where: { orderno },
            update: updateData,
            create: { orderno, ...orderData },
          });

          if (!isExisting) {
            existingOrderMap.set(orderno, salesOrder.id);
          }

          if (isExisting) {
            results.salesOrdersUpdated++;
          } else {
            results.salesOrdersCreated++;
          }

          const existingLines = await tx.orderLineItem.findMany({
            where: { salesOrderId: salesOrder.id },
            select: {
              id: true,
              lineNumber: true,
              lineItemStatus: true,
              cancelReason: true,
            },
          });
          const existingLineMap = new Map(existingLines.map((l) => [l.lineNumber, l]));

          for (let i = 0; i < orderLines.length; i++) {
            const row = orderLines[i];
            const lineNumber = i + 1;
            const barcode = safeString(row["Barcode No"]);
            const netPrice = safeFloat(row.netprice);

            const product = barcode ? barcodeProductMap.get(barcode.toLowerCase()) : null;
            const csvPartNo = safeString(row["Part No"]);
            // Ordorite's "Product Name" column is the canonical product name.
            // The `ordernotes` column is the salesperson's freeform note
            // (delivery address, courtesy memo, etc.) -- it belongs on
            // SalesOrder.orderNotes, never on a line item's productName.
            // Earlier versions had a `|| safeString(row.ordernotes)` fallback
            // here that polluted productName with note text and broke
            // reports filtering on productName (see post-failure log
            // 2026-05-01: Susan Roberts SBOM38708 productName "Delivery to
            // 8 Monticello Dr East Lyme"). Drop the fallback.
            const csvProductName = safeString(row["Product Name"]) || undefined;

            // 2026-05-15: REMOVED the findProduct({ autoCreate: true })
            // fallback that previously fired here. That path created stub
            // Product rows for unknown part numbers and indirectly led to
            // line items being linked to wrong canonical products like
            // DELIVERY CHARGE / Quote Placeholder when the real product/UPC
            // hadn't synced into our catalog yet. CHOM1678 line 2 was the
            // user-reported instance — barcode 100218112 is CRL-7000-18L
            // "Big Easy One Arm Chair" per the Upc table (registered
            // 2026-05-12) but the line was stuck linked to product 54665
            // DELIVERY CHARGE from a prior import path.
            //
            // New behavior: if barcode doesn't match any UPC AND no Product
            // matches partNo, leave productId NULL. The
            // backfillLineItemProductLinks call at the end of runSalesImport
            // (with fixWrongLinks: true) re-runs on every import, so once
            // the product/UPC syncs in, the line gets correctly linked
            // automatically — no more stale wrong links.

            const lineData = {
              partNo: product?.productNumber || csvPartNo || barcode || undefined,
              porNumber: safeString(row["Por Number"]) || undefined,
              barcode: barcode || undefined,
              productName: product?.name || csvProductName || undefined,
              orderedQuantity: safeFloat(row.Orderqty || row.Qty),
              netPrice,
              cost: product ? safeFloat(row.cost || row.Cost) : netPrice,
              productId: product?.id || undefined,
              vatRate: safeFloat(row.Vatrate),
              vatAmount: safeFloat(row.Vatamount),
              taxDistrictId,
            };

            const existingLine = existingLineMap.get(lineNumber);
            let lineItemId: number;
            if (existingLine) {
              // If the line was previously CANCELLED by orphan cleanup
              // (no cancelReason set), and the CSV now provides a row at
              // this lineNumber, reactivate it. User-cancelled lines
              // (cancelReason set) keep their CANCELLED status — those
              // are deliberate intent we don't want to undo.
              //
              // Without this reactivation, orders that oscillate in line
              // count across re-imports get stuck with permanently-
              // cancelled lines that should be active. Real example
              // (post-failure log 2026-05-02): SBOM39275 had 17 lines on
              // first import, grew to 22, shrank to 17 (orphan-cancelled
              // 18-22), then grew to 29 — but lines 18-29 stayed
              // CANCELLED, dropping $7,819 from the Detailed Sales report.
              const isOrphanCancelled =
                existingLine.lineItemStatus === "CANCELLED" && !existingLine.cancelReason;
              const updateData = isOrphanCancelled
                ? { ...lineData, lineItemStatus: "ACTIVE" as const }
                : lineData;
              await tx.orderLineItem.update({
                where: { id: existingLine.id },
                data: updateData,
              });
              lineItemId = existingLine.id;
              results.lineItemsUpdated++;
            } else {
              const created = await tx.orderLineItem.create({
                data: { salesOrderId: salesOrder.id, lineNumber, ...lineData },
              });
              lineItemId = created.id;
              results.lineItemsCreated++;
            }

            const porNumber = safeString(row["Por Number"]);
            if (porNumber) {
              const poItem = await tx.purchaseOrderItem.findUnique({
                where: { externalPorNo: porNumber },
                select: { id: true, orderLineItemId: true, purchaseOrderId: true },
              });
              if (poItem && poItem.orderLineItemId !== lineItemId) {
                await tx.purchaseOrderItem.update({
                  where: { id: poItem.id },
                  data: { orderLineItemId: lineItemId },
                });
                const po = await tx.purchaseOrder.findUnique({
                  where: { id: poItem.purchaseOrderId },
                  select: { id: true, salesOrderId: true },
                });
                if (po && !po.salesOrderId) {
                  await tx.purchaseOrder.update({
                    where: { id: po.id },
                    data: { salesOrderId: salesOrder.id },
                  });
                }
                results.poLinksCreated++;
              }
            }
          }

          // Remove orphaned line items (lines beyond what the CSV provides).
          // Orphan cleanup: when an order is reimported with fewer lines than
          // a prior run, mark the now-missing lines as CANCELLED rather than
          // deleting them. Deletion fails the whole transaction with a
          // foreign-key violation when an InvoiceLineItem points at the row
          // (which is common: yesterday's invoice import created the FK
          // references, today's sales reimport tries to remove the line).
          // CLAUDE.md rule 33 already says reports must filter
          // lineItemStatus != "CANCELLED", so the report math stays correct
          // and the InvoiceLineItem.orderLineItemId FK still resolves.
          //
          // EXCEPTION (post-failure log 2026-05-05, SBOM39275):
          // If this order has been REWRITTEN (a sibling `<orderno> - A/B/C/D`
          // exists in the DB), do NOT orphan-cancel. Once Ordorite creates a
          // rewrite, its CSV permanently exports only the "kept" lines on the
          // base — the items that "moved" to the rewrite no longer appear in
          // the base order's CSV section, even though the base's daily-sales
          // total per Ordorite still reflects the FULL pre-rewrite line set.
          // Orphan-cleanup would silently drop those lines and the base's
          // historical date no longer matches Ordorite's daily report. The
          // rewrite-chain accounting (CLAUDE.md gotcha "Order rewrites keep
          // the whole chain active") relies on the base keeping its original
          // line items so daily-by-store totals reconcile. The matching SBOA
          // accounting return on the rewrite's date nets the chain correctly.
          //
          // Note: only the orphan-CANCEL is skipped. The per-row UPDATE above
          // still runs, so a manual re-import of a corrected CSV can still
          // refresh values, and the PR #201 reactivation will bring back any
          // previously-cancelled lines that the CSV now provides.
          const baseHasRewrite =
            !isRewriteOrder(orderno) &&
            (await tx.salesOrder.findFirst({
              where: { orderno: { startsWith: `${orderno} - ` } },
              select: { id: true },
            })) !== null;
          const maxLine = orderLines.length;
          const orphanedLines = baseHasRewrite
            ? []
            : existingLines.filter((l) => l.lineNumber !== null && l.lineNumber > maxLine);
          if (orphanedLines.length > 0) {
            await tx.orderLineItem.updateMany({
              where: { id: { in: orphanedLines.map((l) => l.id) } },
              data: { lineItemStatus: "CANCELLED" },
            });
          }

          // Collect Marjan rug identifiers for consignment SOLD sync.
          // Physical barcode (M-format UPC on the product) is primary; customerNumber is fallback.
          if (status !== "RETURNED" && status !== "CANCELLED") {
            const rugMatches: { barcode: string | null; customerNumber: string | null }[] = [];
            for (const row of orderLines) {
              const csvBarcode = safeString(row["Barcode No"]);
              const product = csvBarcode ? barcodeProductMap.get(csvBarcode.toLowerCase()) : null;
              const pn = product?.productNumber;
              if (pn && isMarjanRug(pn)) {
                // The CSV barcode is Ordorite's internal number, not the physical rug.
                // The physical barcode starts with M and is the UPC that matched this product.
                // If the CSV barcode itself starts with M, it IS the physical barcode.
                const physicalBarcode = csvBarcode && /^M\d/.test(csvBarcode) ? csvBarcode : null;
                const cn = toMarjanCustomerNumber(pn);
                rugMatches.push({ barcode: physicalBarcode, customerNumber: cn });
              }
            }
            if (rugMatches.length > 0) {
              soldRugOrders.push({
                salesOrderId: salesOrder.id,
                rugMatches,
                orderDate: safeDate(firstRow.Orderdate) || new Date(),
              });
            }
          }
        } catch (innerError: unknown) {
          const msg = innerError instanceof Error ? innerError.message : String(innerError);
          results.errors.push(`Order ${orderno}: ${msg}`);
        }
      }
    }, TX_TIMEOUT.LONG);

    // Revert consignment rugs from SOLD → ON_FLOOR for any returns in this batch.
    // Done outside the transaction so syncConsignmentReturns uses the main client.
    if (returnedLineItems.length > 0) {
      await syncConsignmentReturns(returnedLineItems);
    }

    // Mark consignment items as SOLD for any Marjan rugs on non-returned orders.
    // Match by physical barcode first (M-format, never changes), customerNumber as fallback.
    // Include RETURNED_VENDOR in matchable statuses — rugs can come back from Marjan
    // and sell again without being re-received through the manifest import.
    const matchableStatuses: ("ON_FLOOR" | "ON_APPROVAL" | "RETURNED_VENDOR")[] = [
      "ON_FLOOR",
      "ON_APPROVAL",
      "RETURNED_VENDOR",
    ];
    for (const { salesOrderId, rugMatches, orderDate } of soldRugOrders) {
      for (const { barcode, customerNumber } of rugMatches) {
        // Primary: match by physical barcode (starts with M, never changes)
        let item = barcode
          ? await prisma.consignmentItem.findFirst({
              where: { barcode },
              select: { id: true, status: true, creditOwed: true },
            })
          : null;
        // Fallback: match by customerNumber
        if (!item && customerNumber) {
          item = await prisma.consignmentItem.findFirst({
            where: { customerNumber },
            select: { id: true, status: true, creditOwed: true },
          });
        }
        if (!item) continue;

        // PAID item with creditOwed on a new sale: exchange or return-and-rebuy.
        // The re-sale cancels the credit. Clear creditOwed but keep PAID.
        if (item.status === "PAID" && item.creditOwed) {
          await prisma.consignmentItem.update({
            where: { id: item.id },
            data: { creditOwed: false },
          });
          results.consignmentItemsSynced++;
          continue;
        }

        // Only transition from matchable statuses
        if (
          !matchableStatuses.includes(item.status as "ON_FLOOR" | "ON_APPROVAL" | "RETURNED_VENDOR")
        ) {
          continue;
        }

        await prisma.consignmentItem.update({
          where: { id: item.id },
          data: {
            status: "SOLD",
            salesOrderId,
            saleDate: orderDate,
            ...(item.creditOwed ? { creditOwed: false } : {}),
          },
        });
        results.consignmentItemsSynced++;
      }
    }

    // Reconciliation: detect same-batch wash items (a rug whose returns fully
    // offset its sales within this import batch). The sale processed after the
    // return (syncConsignmentReturns runs first, before the rug is SOLD),
    // leaving the item SOLD when it should be ON_FLOOR. findWashedRugCustomerNumbers
    // matches on customerNumber (the sold side carries the physical rug barcode,
    // the returned side the product-number-derived barcode — they never match
    // directly) and only flags a rug net-returned in the batch, so a re-sold /
    // rewritten rug (more sales than returns) stays SOLD. Revert the un-paid ones.
    const washedCustomerNumbers = findWashedRugCustomerNumbers(
      soldRugOrders.flatMap((o) => o.rugMatches),
      returnedLineItems.map((r) => r.productNumber),
    );
    for (const customerNumber of washedCustomerNumbers) {
      const item = await prisma.consignmentItem.findFirst({
        where: { customerNumber },
        select: { id: true, status: true, consignmentPaymentBatchId: true },
      });
      if (item?.status === "SOLD" && !item.consignmentPaymentBatchId) {
        // Never paid — same-day sell+return wash. Revert to ON_FLOOR.
        await prisma.consignmentItem.update({
          where: { id: item.id },
          data: { status: "ON_FLOOR", salesOrderId: null, saleDate: null },
        });
      }
    }
  }

  // Same-day rewrite cleanup (2026-05-12). The "rewrite chain keeps all
  // three orders active, daily totals reconcile naturally" guidance above
  // is true for CROSS-DAY rewrites where the base + return + rewrite each
  // land on their own date. But for SAME-DAY rewrites, Ordorite's
  // accounting return only covers items the customer KEPT (the rewrite
  // amount), not the items they DROPPED. The dropped items dangle in the
  // base as ACTIVE-but-uncanceled lines and double-count daily sales.
  //
  // Worked example: CHOM1726 on 2026-05-09 (Brian Tenerow, Cheshire).
  // Base $4,298 (5 lines) + Return -$3,189 (3 lines) + Rewrite $3,189
  // (3 lines) -> naive sum is $4,298 vs. Ordorite's $3,189 (a $1,109
  // delta = the 2 lounge chairs + extra delivery line that the customer
  // dropped same-day, which Ordorite never returned). User report
  // 2026-05-12.
  //
  // Cleanup rule: for any rewrite whose orderDate matches its base's
  // orderDate, cancel base line items whose lineNumber exceeds the
  // rewrite's max lineNumber (mirrors the existing orphan-cleanup
  // pattern). Idempotent — already-CANCELLED lines are skipped.
  //
  // Cross-day rewrites are unaffected. The check is `base.orderDate ==
  // rewrite.orderDate`; cross-day chains skip the cleanup entirely.
  await cancelSameDayRewriteDroppedLines(orderNumbers, results);

  // Post-import self-healing of product links. This is what makes the
  // CHOM1678-style timing issue self-correcting:
  //   - Lines created with productId NULL (because the UPC hadn't synced
  //     in yet) get linked once the UPC arrives — strategy 1/2/3.
  //   - Lines that are wrongly linked to a different product (UPC says
  //     X but line points to Y) get re-linked, syncing productName too.
  //     Marjan-to-Marjan dups are skipped because Ordorite intentionally
  //     creates multiple Product records for the same physical rug as
  //     it's returned and re-consigned.
  // Scoped by the import's order numbers so the scan is cheap (Postgres
  // uses the order-id index path).
  try {
    const relink = await backfillLineItemProductLinks({ fixWrongLinks: true });
    if (relink.updated > 0) results.lineItemsLinked = relink.updated;
    if (relink.wrongLinksFixed > 0) results.lineItemsRelinked = relink.wrongLinksFixed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.errors.push(`post-import relink: ${msg}`);
  }

  // salesPersonId FK self-heal — Ordorite imports only populate the
  // `salesperson` STRING. This sweep resolves it to a StaffMember via
  // displayName + aliases match, so reports that filter by FK still
  // catch every order whose attribution can be unambiguously resolved.
  // Idempotent + cheap (only touches NULL-FK rows).
  // Origin: Issue #274 follow-up, ROADMAP Short-Term #12 wrap.
  try {
    const fkBackfill = await backfillSalesPersonFk(prisma);
    if (fkBackfill.updated > 0) results.salesPersonFkBackfilled = fkBackfill.updated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.errors.push(`post-import salesPerson FK backfill: ${msg}`);
  }

  return results;
}

/**
 * Post-import sweep: find every same-day rewrite chain among the orders
 * we just imported and CANCEL the dropped lines in their bases. Pure
 * helper for the detection lives in `lib/sameDayRewriteCleanup.ts`.
 *
 * Runs OUTSIDE the per-batch transaction — same-day cleanup is
 * idempotent and we don't want one chain's failure to roll back the
 * whole import.
 */
async function cancelSameDayRewriteDroppedLines(
  importedOrdernos: readonly string[],
  results: { sameDayRewriteLinesCancelled?: number; errors: string[] },
): Promise<void> {
  const rewriteOrdernos = importedOrdernos.filter(isRewriteOrder);
  if (rewriteOrdernos.length === 0) return;

  let totalCancelled = 0;
  for (const rewriteOrderno of rewriteOrdernos) {
    try {
      totalCancelled += await cleanupOneRewriteChain(rewriteOrderno);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`same-day rewrite cleanup for ${rewriteOrderno}: ${msg}`);
    }
  }
  if (totalCancelled > 0) {
    results.sameDayRewriteLinesCancelled = totalCancelled;
  }
}

/**
 * Per-rewrite cleanup: look up the base + same-day return for the same
 * customer, find dropped lines (no return, no rewrite match), mark them
 * CANCELLED. Returns the count cancelled.
 *
 * Updated 2026-05-22 (failure-log SBOM39876 + structural lookup fix):
 * Returns are now looked up by `(customerId, orderDate, prefix-pattern)`
 * — NOT by orderno-swap. Ordorite's accounting-return ordernos use an
 * independent numeric sequence: CHOM1726's matching return is
 * CHOA010045, SBOM38847's is SBOA013491, etc. The earlier
 * `swapToReturnPrefix` produced e.g. "SBOA39876" which never exists.
 * That bug meant the runner ran against `returnLines = []` in ~99% of
 * same-day rewrites (193 of 195 in the 2026-05-22 audit) — gate 2 of
 * the heuristic was perpetually trivially-satisfied, so cancellation
 * decisions fell back to position + rewrite-partNo alone. CHOM1726
 * happened to come out right by coincidence; SBOM39876 didn't.
 *
 * Updated 2026-05-15 (failure-log SBOM39618): the OLD implementation
 * used a lineNumber-based proxy that over-cancelled base lines that had
 * matching returns (truly kept-with-credit-cycle). The combined three-
 * gate heuristic in `findDroppedBaseLineIds` corrected that.
 *
 * The base-lookup MUST include `orderDate = rewrite.orderDate` to avoid
 * over-firing on cross-day rewrites.
 *
 * Removed 2026-05-22 (same-day, follow-up to PR #321): an earlier
 * version of this function had a `>= 50%` safety guard intended to
 * catch price-tweak rewrites (SBOM39876 shape). The guard fired too
 * aggressively at the boundary: SBOM39006 cancelled 1 of 2 base lines
 * (50% exactly — drop case) got wrongly classified as a price-tweak +
 * skipped. Owner-reported OS 5/1-5/20 gap of $1,100 = exactly SBOM39006
 * line 2 (BAT-MU01). Migration `20260522d_recancel_wrongly_restored_
 * drops` re-cancels the 12 drop cases the >=50% guard wrongly restored.
 *
 * Going forward: rely on the operator flag `skipSameDayRewriteCleanup`
 * for price-tweak cases (SBOM39876). A price-tweak case is rare; the
 * operator sets the flag once the daily reconciliation surfaces it.
 * The return-lookup fix (the structural improvement from PR #321) is
 * preserved — that's the real defense against the original CHOM1726
 * vs SBOM39876 misclassification.
 */
async function cleanupOneRewriteChain(rewriteOrderno: string): Promise<number> {
  const baseOrderno = rewriteBaseOrderno(rewriteOrderno);
  if (!baseOrderno) return 0;

  const rewrite = await prisma.salesOrder.findFirst({
    where: { orderno: rewriteOrderno },
    select: {
      orderDate: true,
      lineItems: {
        select: {
          id: true,
          lineNumber: true,
          lineItemStatus: true,
          partNo: true,
          orderedQuantity: true,
        },
      },
    },
  });
  if (!rewrite) return 0;

  const base = await prisma.salesOrder.findFirst({
    where: { orderno: baseOrderno, orderDate: rewrite.orderDate },
    select: {
      id: true,
      customerId: true,
      skipSameDayRewriteCleanup: true,
      lineItems: {
        select: {
          id: true,
          lineNumber: true,
          lineItemStatus: true,
          partNo: true,
          orderedQuantity: true,
        },
      },
    },
  });
  if (!base) return 0; // Cross-day rewrite or no base — nothing to do.

  // Operator override: when the base order is flagged
  // `skipSameDayRewriteCleanup = true`, skip the heuristic entirely.
  // The sole escape hatch for the rare price-tweak rewrite shape
  // (SBOM39876 — customer kept everything; rewrite is a price tweak
  // only). Operator sets the flag once daily reconciliation surfaces
  // the discrepancy.
  if (base.skipSameDayRewriteCleanup) return 0;

  // Find the matching same-day accounting return by
  // (customerId, orderDate, prefix-pattern). Per Ordorite's
  // numbering: SBOA/CHOA/GTOA/BBOA/WSOA/RSOA are accounting-return
  // prefixes that use a separate numeric sequence from the base SBOM/
  // CHOM/etc. orders. A customer typically has at most one same-day
  // accounting return per base order, but if there are multiple we
  // merge all line items so consumption-matching works across the set.
  const returnPrefix = sameDayReturnPrefixFor(baseOrderno);
  const returnLines =
    returnPrefix && base.customerId && rewrite.orderDate
      ? await loadSameDayReturnLines({
          customerId: base.customerId,
          orderDate: rewrite.orderDate,
          prefix: returnPrefix,
        })
      : [];

  const droppedIds = findDroppedBaseLineIds({
    baseLines: base.lineItems.map(toCleanupLine),
    rewriteLines: rewrite.lineItems.map(toCleanupLine),
    returnLines,
  });
  if (droppedIds.length === 0) return 0;

  await prisma.orderLineItem.updateMany({
    where: { id: { in: droppedIds } },
    data: { lineItemStatus: "CANCELLED" },
  });
  return droppedIds.length;
}

// Map a base orderno to its same-day accounting-return prefix.
// SBOM→SBOA, CHOM→CHOA, GTOM→GTOA, BBOM→BBOA, WSOM→WSOA, RSOM→RSOA.
// Returns null when the input doesn't match a known store-prefix shape.
function sameDayReturnPrefixFor(baseOrderno: string): string | null {
  const match = /^([A-Z]{2})OM\d/.exec(baseOrderno);
  if (!match) return null;
  return `${match[1]}OA`;
}

// Load all line items from same-day accounting-return orders for a
// given customer + date + prefix. Per CLAUDE.md gotcha 13, Ordorite's
// return ordernos do NOT mirror the base orderno; the only reliable
// match is (customer, date, status, prefix-pattern).
async function loadSameDayReturnLines(args: {
  customerId: number;
  orderDate: Date;
  prefix: string;
}): Promise<import("@/lib/adapters/ordorite/sameDayRewriteCleanup").LineItemForCleanup[]> {
  const returns = await prisma.salesOrder.findMany({
    where: {
      customerId: args.customerId,
      orderDate: args.orderDate,
      orderno: { startsWith: args.prefix },
    },
    select: {
      lineItems: {
        select: {
          id: true,
          lineNumber: true,
          lineItemStatus: true,
          partNo: true,
          orderedQuantity: true,
        },
      },
    },
  });
  return returns.flatMap((ret) => ret.lineItems.map(toCleanupLine));
}

// Coerce a Prisma-shaped line item into the pure helper's input shape.
// Prisma returns `orderedQuantity` as a Decimal; the helper compares
// numerically so we convert here. Same for the rewrite/return paths.
function toCleanupLine(li: {
  id: number;
  lineNumber: number | null;
  lineItemStatus: string;
  partNo: string | null;
  orderedQuantity: Prisma.Decimal | number;
}): import("@/lib/adapters/ordorite/sameDayRewriteCleanup").LineItemForCleanup {
  return {
    id: li.id,
    lineNumber: li.lineNumber,
    lineItemStatus: li.lineItemStatus,
    partNo: li.partNo,
    orderedQuantity:
      typeof li.orderedQuantity === "number"
        ? li.orderedQuantity
        : Number(li.orderedQuantity.toString()),
  };
}

// ---------------------------------------------------------------------------
// Quotes import
// ---------------------------------------------------------------------------

export interface QuotesImportResult {
  quotesCreated: number;
  quotesUpdated: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  lineItemsCancelled: number;
  errors: string[];
}

function mapQuoteStatus(row: Record<string, unknown>): "QUOTE" | "CANCELLED" {
  const status = safeString(row.Status)?.toLowerCase();
  if (status === "declined") return "CANCELLED";
  // Ordorite marks quotes as "converted" when a deposit is taken, but FM
  // still treats them as quotes until invoiced. Only the sales import
  // (which pulls actual invoiced orders) should create ORDER-status records.
  return "QUOTE";
}

// Build the OrderLineItem-shaped data from one CSV row. Used by both the
// new-order create path and the existing-order reconcile path so the field
// set can't drift between them. Quote CSVs do not include barcode / POR /
// VAT / productId -- those only land via runSalesImport once a quote
// becomes a sale. Exported for unit-testing in isolation.
export function buildQuoteLineData(row: Record<string, unknown>) {
  return {
    partNo: safeString(row["Part No"]) || undefined,
    productName: safeString(row["Product Name"]) || undefined,
    orderedQuantity: safeFloat(row.Orderqty || row.Qty),
    netPrice: safeFloat(row["Sellingprice Exvat"] || row.netprice),
    cost: safeFloat(row["Sellingprice Exvat"] || row.Cost || row.netprice),
  };
}

// Reconciles an existing quote's line items against what's now in the CSV.
// Mirrors runSalesImport's pattern (this same file, ~line 280). Without
// this, line-item changes after the first import are silently dropped --
// the bug that left SBOM38985 with 1 line item when Ordorite had more
// (CLAUDE.md gotcha + post-failure log entry 2026-04-28).
//
// Extracted from runQuotesImport's main loop to keep the loop's cognitive
// complexity below the Sonar S3776 threshold (was 21).
async function reconcileExistingQuoteOrder(
  tx: PrismaClient,
  args: {
    existingId: number;
    orderno: string;
    orderLines: Record<string, unknown>[];
    quoteCode: string | undefined;
    quoteDate: Date | undefined;
  },
  results: QuotesImportResult,
): Promise<void> {
  const { existingId, orderno, orderLines, quoteCode, quoteDate } = args;
  const firstRow = orderLines[0];

  // Cuscode reconciliation for existing quotes (post-2026-05-20 fix).
  // When Ordorite adds Cuscode to the Daily Quote Report, the next
  // import of an existing quote that previously shipped without it
  // hydrates the customer link + populates SalesOrder.externalCustomerCode.
  // findOrCreateCustomer's cuscode upsert at the end of its body writes
  // the CustomerExternalId link; the SalesOrder update below writes
  // externalCustomerCode so reports and downstream linkage queries work.
  const cuscode = safeString(firstRow.Cuscode);
  const customerName = safeString(firstRow.Customer);
  const email = normalizeEmail(firstRow.Email) || undefined;
  if (cuscode || customerName) {
    await findOrCreateCustomer(tx as never, {
      cuscode,
      customerName,
      email,
      createdBy: "automated-quote-import",
    });
  }

  await tx.salesOrder.update({
    where: { orderno },
    data: {
      quoteCode,
      quoteDate,
      // Use { set: undefined } pattern: when cuscode is empty we leave
      // the existing value alone (some quotes were promoted then
      // demoted, keeping a sales-runner-set cuscode that we shouldn't
      // clear). When cuscode is present, write it.
      ...(cuscode ? { externalCustomerCode: cuscode } : {}),
    },
  });
  results.quotesUpdated++;

  const existingLines = await tx.orderLineItem.findMany({
    where: { salesOrderId: existingId },
    select: {
      id: true,
      lineNumber: true,
      lineItemStatus: true,
      cancelReason: true,
    },
  });
  const existingLineMap = new Map(existingLines.map((l) => [l.lineNumber, l] as const));

  for (let i = 0; i < orderLines.length; i++) {
    const lineNumber = i + 1;
    const lineData = buildQuoteLineData(orderLines[i]);
    const existingLine = existingLineMap.get(lineNumber);
    if (existingLine) {
      // Reactivate orphan-cancelled lines when the CSV provides them
      // again. Same rationale as runSalesImport (post-failure log
      // 2026-05-02). User-cancelled lines (cancelReason set) keep
      // CANCELLED status.
      const isOrphanCancelled =
        existingLine.lineItemStatus === "CANCELLED" && !existingLine.cancelReason;
      const updateData = isOrphanCancelled
        ? { ...lineData, lineItemStatus: "ACTIVE" as const }
        : lineData;
      await tx.orderLineItem.update({ where: { id: existingLine.id }, data: updateData });
      results.lineItemsUpdated++;
    } else {
      await tx.orderLineItem.create({
        data: { salesOrderId: existingId, lineNumber, ...lineData },
      });
      results.lineItemsCreated++;
    }
  }

  // Orphan cleanup: any existing line whose lineNumber sits beyond the
  // CSV's row count is now CANCELLED (matches runSalesImport behavior +
  // CLAUDE.md rule 33: cancelled lines must never inflate report totals).
  //
  // REWRITE-FREEZE (defense in depth, 2026-05-07):
  // Same shape as runSalesImport's freeze. The runQuotesImport caller
  // already gates this function behind `existing.status === "QUOTE"`, so
  // a promoted ORDER never reaches here today. But if a future change
  // re-allows this code path for a non-QUOTE order, the freeze still
  // protects the base. Once a sibling rewrite exists, Ordorite's CSVs
  // permanently export only the "kept" subset on the base — orphan-
  // cancelling here would silently drop lines that legitimately stayed
  // on the base. See `lib/ordoriteImportRunners.ts:430` for the same
  // shape on the sales runner.
  const baseHasRewrite =
    !isRewriteOrder(orderno) &&
    (await tx.salesOrder.findFirst({
      where: { orderno: { startsWith: `${orderno} - ` } },
      select: { id: true },
    })) !== null;
  const orphans = baseHasRewrite
    ? []
    : existingLines.filter((l) => l.lineNumber !== null && l.lineNumber > orderLines.length);
  if (orphans.length > 0) {
    const cancelled = await tx.orderLineItem.updateMany({
      where: { id: { in: orphans.map((o) => o.id) } },
      data: { lineItemStatus: "CANCELLED" },
    });
    results.lineItemsCancelled += cancelled.count;
  }
}

export async function runQuotesImport(
  quoteData: Record<string, unknown>[],
  createdBy?: string,
): Promise<QuotesImportResult> {
  const results: QuotesImportResult = {
    quotesCreated: 0,
    quotesUpdated: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    lineItemsCancelled: 0,
    errors: [],
  };

  const ordersMap = new Map<string, Record<string, unknown>[]>();
  for (const row of quoteData) {
    const orderno = safeString(row.Orderno);
    if (orderno) {
      if (!ordersMap.has(orderno)) ordersMap.set(orderno, []);
      ordersMap.get(orderno)!.push(row);
    } else {
      results.errors.push("Skipped row: missing Orderno");
    }
  }

  const orderNumbers = Array.from(ordersMap.keys());
  const existingOrders = await prisma.salesOrder.findMany({
    where: { orderno: { in: orderNumbers } },
    select: { id: true, orderno: true, status: true },
  });
  const existingOrderMap = new Map(existingOrders.map((o) => [o.orderno, o]));

  const locationMap = await buildLocationMap();

  const orderEntries = Array.from(ordersMap.entries());
  for (let batchStart = 0; batchStart < orderEntries.length; batchStart += BATCH_SIZE) {
    const batch = orderEntries.slice(batchStart, batchStart + BATCH_SIZE);

    await prisma.$transaction(async (tx) => {
      for (const [orderno, orderLines] of batch) {
        try {
          const firstRow = orderLines[0];
          const quoteCode = safeString(firstRow.Quotecode) || undefined;
          const quoteDate = safeDate(firstRow.Orderdate) || undefined;
          const existing = existingOrderMap.get(orderno);

          if (existing) {
            // PROMOTED-ORDER GUARD (post-failure log 2026-05-07, SBOM39275
            // recurrence): the Daily Quote Report includes ANY order that
            // ever had a quoteCode, including ones that have since been
            // promoted to status=ORDER (or RETURNED, or CANCELLED). The
            // quote CSV's `Sellingprice Exvat` column is a UNIT price, not
            // a line total — so re-importing a promoted order through this
            // path would overwrite the multi-qty lines' correct line totals
            // with their unit prices. The CSV also presents only a
            // truncated "kept" set after a rewrite, which would re-cancel
            // the moved-to-rewrite lines on the base.
            //
            // Once an order has graduated from QUOTE, the Sales runner
            // (runSalesImport) is the authoritative source for its line
            // items. Do NOT touch promoted orders from the quote import.
            if (existing.status !== "QUOTE") {
              continue;
            }
            await reconcileExistingQuoteOrder(
              tx as unknown as PrismaClient,
              { existingId: existing.id, orderno, orderLines, quoteCode, quoteDate },
              results,
            );
            continue;
          }

          const cuscode = safeString(firstRow.Cuscode);
          const customerName = safeString(firstRow.Customer);
          const email = normalizeEmail(firstRow.Email) || undefined;
          // Cuscode added to the Daily Quote Report export 2026-05-20. Before
          // that date the column was absent, so `cuscode` was always
          // undefined here — 225 of 228 April-and-later quotes shipped with
          // no CustomerExternalId link and no SalesOrder.externalCustomerCode.
          // The sales runner papers over this when the quote is promoted to
          // ORDER (it overwrites externalCustomerCode + writes the link), but
          // quotes that never promote stay unhydrated forever. Pass cuscode
          // through here so findOrCreateCustomer can write the link AND
          // store the value on the SalesOrder for future reconciliation.
          const customer = await findOrCreateCustomer(tx as never, {
            cuscode,
            customerName,
            email,
            createdBy,
          });
          const storeLocationStr = safeString(firstRow.Company);
          const desiredStatus = mapQuoteStatus(firstRow);
          const salesOrder = await tx.salesOrder.create({
            data: {
              orderno,
              orderDate: safeDate(firstRow.Orderdate) ?? null,
              customerId: customer?.id,
              externalCustomerCode: cuscode || undefined,
              salesperson: safeString(firstRow.Salesperson),
              storeLocation: storeLocationStr,
              storeLocationId: locationMap.get(storeLocationStr?.toLowerCase() ?? "") ?? undefined,
              quoteCode,
              quoteDate,
              status: desiredStatus,
            },
          });
          results.quotesCreated++;

          existingOrderMap.set(orderno, {
            id: salesOrder.id,
            orderno,
            status: desiredStatus,
          });

          for (let i = 0; i < orderLines.length; i++) {
            await tx.orderLineItem.create({
              data: {
                salesOrderId: salesOrder.id,
                lineNumber: i + 1,
                ...buildQuoteLineData(orderLines[i]),
              },
            });
            results.lineItemsCreated++;
          }
        } catch (innerError: unknown) {
          const msg = innerError instanceof Error ? innerError.message : String(innerError);
          results.errors.push(`Order ${orderno}: ${msg}`);
        }
      }
    }, TX_TIMEOUT.LONG);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Deposits import
// ---------------------------------------------------------------------------

export interface DepositsImportResult {
  ordersUpdated: number;
  ordersNotFound: number;
  errors: string[];
}

export async function runDepositsImport(
  depositData: Record<string, unknown>[],
): Promise<DepositsImportResult> {
  const results: DepositsImportResult = {
    ordersUpdated: 0,
    ordersNotFound: 0,
    errors: [],
  };

  for (const row of depositData) {
    const orderno = safeString(row.Orderno);
    if (!orderno) {
      results.errors.push("Skipped: missing Orderno");
      continue;
    }

    const salesOrder = await prisma.salesOrder.findUnique({ where: { orderno } });
    if (!salesOrder) {
      results.ordersNotFound++;
      continue;
    }

    const paid = safeFloat(row.Paid);
    const totalTax = safeFloat(row.Total) - safeFloat(row["Net Deposits"]);

    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: {
        totalPaid: paid,
        totalTax: totalTax > 0 ? totalTax : salesOrder.totalTax,
      },
    });
    results.ordersUpdated++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Purchase orders import
// ---------------------------------------------------------------------------

export interface PurchaseOrdersImportResult {
  purchaseOrdersCreated: number;
  purchaseOrdersUpdated: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  consignmentBatchesCreated: number;
  consignmentItemsPaid: number;
  /** Slice 6.10 — draft POs auto-flipped to FULFILLED because every
   *  linked product now appears on a real PO with RECEIVED_FULL or
   *  RECEIVED_PARTIAL status. */
  buyerDraftPosAutoFulfilled?: number;
  /** Slice 6.14 — count of newly-imported real POs that the post-import
   *  sweep auto-linked to an existing buyer-draft PO via the M:N
   *  BuyerDraftPoRealPoLink table. */
  buyerDraftPoAutoLinked?: number;
  errors: string[];
}

type NameIdMap = Map<string, number>;

async function buildVendorCache(): Promise<NameIdMap> {
  const vendors = await prisma.vendor.findMany({ select: { id: true, name: true } });
  const map: NameIdMap = new Map();
  for (const v of vendors) map.set(v.name.toLowerCase(), v.id);
  return map;
}

async function findOrCreateVendor(name: string, cache: NameIdMap): Promise<number> {
  const key = name.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  const vendor = await prisma.vendor.create({ data: { name, pricingModel: "FLAT" } });
  cache.set(key, vendor.id);
  return vendor.id;
}

export async function runPurchaseOrdersImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<PurchaseOrdersImportResult> {
  const results: PurchaseOrdersImportResult = {
    purchaseOrdersCreated: 0,
    purchaseOrdersUpdated: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    consignmentBatchesCreated: 0,
    consignmentItemsPaid: 0,
    errors: [],
  };

  const vendorCache = await buildVendorCache();
  const userEmail = createdBy || "auto-import";

  // Track POs that transition to RECEIVED_FULL for consignment payment sync.
  const newlyReceivedPOs: { poId: number; poNumber: string; vendorId: number; orderDate: Date }[] =
    [];

  for (const row of records) {
    const porNo = safeString(row["Porno"] || row["porno"]);
    try {
      const poNumber = safeString(row["Pono"] || row["pono"]);
      if (!poNumber) {
        results.errors.push(`[${porNo || "unknown"}]: Missing PO number (Pono)`);
        continue;
      }

      const supplierName = safeString(row["Supplier"] || row["supplier"]);
      if (!supplierName) {
        results.errors.push(`[${porNo || poNumber}]: Missing supplier name`);
        continue;
      }

      const vendorId = await findOrCreateVendor(supplierName, vendorCache);
      const orderDate = parseDateFlexible(row["Podate"] || row["podate"]) || new Date();
      const expectedDate = parseDateFlexible(row["Expecteddate"] || row["expecteddate"]);
      const status = derivePOStatus(row["Postatus"] || row["postatus"]);

      const existingPO = await prisma.purchaseOrder.findUnique({ where: { poNumber } });

      let poId: number;
      if (existingPO) {
        const wasReceived = existingPO.status === "RECEIVED_FULL";
        const poUpdate: Record<string, unknown> = {
          vendorId,
          orderDate,
          status,
          updatedBy: userEmail,
        };
        if (expectedDate) poUpdate.expectedDelivery = expectedDate;
        await prisma.purchaseOrder.update({
          where: { id: existingPO.id },
          data: poUpdate,
        });
        poId = existingPO.id;
        results.purchaseOrdersUpdated++;

        // Detect transition to RECEIVED_FULL for consignment payment sync
        if (status === "RECEIVED_FULL" && !wasReceived) {
          newlyReceivedPOs.push({ poId, poNumber, vendorId, orderDate });
        }
      } else {
        const newPO = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId,
            orderDate,
            expectedDelivery: expectedDate,
            status,
            createdBy: userEmail,
          },
        });
        poId = newPO.id;
        results.purchaseOrdersCreated++;

        if (status === "RECEIVED_FULL") {
          newlyReceivedPOs.push({ poId, poNumber, vendorId, orderDate });
        }
      }

      if (!porNo) continue;

      const externalId = safeString(row["Id"] || row["id"] || row["Productid"]);
      const partNo = safeString(row["Part No"] || row["part_no"]);
      const qty = safeFloat(row["Qty"] || row["qty"]);
      const unitCost = safeFloat(row["Supplier Cost"] || row["supplier_cost"]);
      const productName = safeString(row["Product_name"] || row["product_name"]);

      const product = await findProduct(prisma, {
        externalId,
        partNo,
        productName,
        unitCost,
        vendorId,
        autoCreate: !!partNo,
        createdBy: userEmail,
      });

      const existingItem = await prisma.purchaseOrderItem.findUnique({
        where: { externalPorNo: porNo },
      });

      if (existingItem) {
        await prisma.purchaseOrderItem.update({
          where: { id: existingItem.id },
          data: {
            purchaseOrderId: poId,
            productId: product?.id ?? existingItem.productId,
            orderedQuantity: qty,
            unitCost,
            partNo: partNo || existingItem.partNo,
            productName: productName || existingItem.productName,
          },
        });
        results.lineItemsUpdated++;
      } else {
        await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId: poId,
            externalPorNo: porNo,
            productId: product?.id ?? null,
            orderedQuantity: qty,
            unitCost,
            partNo,
            productName,
          },
        });
        results.lineItemsCreated++;
      }

      const assignedOrder = safeString(row["Assigned Orderno"] || row["assigned_orderno"]);
      if (assignedOrder) {
        const salesOrder = await prisma.salesOrder.findUnique({
          where: { orderno: assignedOrder },
          select: { id: true },
        });
        if (salesOrder) {
          const lineItem = await prisma.purchaseOrderItem.findUnique({
            where: { externalPorNo: porNo },
          });
          if (lineItem && !lineItem.orderLineItemId) {
            const orderLine = await prisma.orderLineItem.findFirst({
              where: { salesOrderId: salesOrder.id, productId: product?.id ?? undefined },
              select: { id: true },
            });
            if (orderLine) {
              await prisma.purchaseOrderItem.update({
                where: { id: lineItem.id },
                data: { orderLineItemId: orderLine.id },
              });
            }
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.errors.push(`[${porNo || "unknown"}]: ${message}`);
    }
  }

  // Create consignment payment batches for Marjan POs that just became RECEIVED_FULL.
  // Matches PO line items to ConsignmentItems via customerNumber and marks them PAID.
  for (const { poId, poNumber, vendorId, orderDate } of newlyReceivedPOs) {
    const vendorEntry = [...vendorCache.entries()].find(([, id]) => id === vendorId);
    if (!vendorEntry || !vendorEntry[0].includes("marjan")) continue;

    // Skip if a payment batch already exists for this PO
    const existingBatch = await prisma.consignmentPaymentBatch.findUnique({
      where: { purchaseOrderId: poId },
    });
    if (existingBatch) continue;

    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: poId },
      select: { partNo: true, unitCost: true },
    });

    // Convert partNos to customerNumbers, then find matching SOLD ConsignmentItems
    const customerNumbers = poItems
      .map((item) => (item.partNo ? toMarjanCustomerNumber(item.partNo) : null))
      .filter((cn): cn is string => cn !== null);

    if (customerNumbers.length === 0) continue;

    // Match SOLD items (normal payment) and ON_FLOOR items (customer returned
    // after sale but vendor is still being paid on this PO → creditOwed).
    const soldItems = await prisma.consignmentItem.findMany({
      where: { customerNumber: { in: customerNumbers }, status: "SOLD" },
      select: { id: true, cost: true },
    });
    const creditItems = await prisma.consignmentItem.findMany({
      where: { customerNumber: { in: customerNumbers }, status: "ON_FLOOR" },
      select: { id: true, cost: true },
    });
    const matchingItems = [...soldItems, ...creditItems];

    if (matchingItems.length === 0) continue;

    const totalAmount = matchingItems.reduce((sum, item) => sum + Number(item.cost || 0), 0);

    const batch = await prisma.consignmentPaymentBatch.create({
      data: {
        vendorId,
        batchDate: orderDate,
        periodStart: orderDate,
        periodEnd: orderDate,
        totalAmount,
        itemCount: matchingItems.length,
        isPaid: true,
        purchaseOrderId: poId,
        notes: `Auto-created from ${poNumber}`,
        createdBy: createdBy || "auto-import",
      },
    });
    results.consignmentBatchesCreated++;

    for (const item of soldItems) {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: { status: "PAID", paidDate: orderDate, consignmentPaymentBatchId: batch.id },
      });
      results.consignmentItemsPaid++;
    }
    for (const item of creditItems) {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "PAID",
          paidDate: orderDate,
          consignmentPaymentBatchId: batch.id,
          creditOwed: true,
        },
      });
      results.consignmentItemsPaid++;
    }
  }

  // Slice 6.10 (2026-05-14) — sweep buyer draft POs whose every linked
  // product now appears on a real PO with RECEIVED_FULL/RECEIVED_PARTIAL
  // status. PO file refresh may have promoted status, so this is the
  // right post-step. Runs OUTSIDE the per-batch transaction (idempotent;
  // a failure here shouldn't roll back the import).
  results.buyerDraftPosAutoFulfilled = await autoFulfillBuyerDraftPos(createdBy ?? null);

  // Slice 6.14 (2026-05-22) — auto-link newly-imported real POs to the
  // buyer's existing draft POs by vendor + item overlap. The forward-
  // flow workflow: buyer drafts items + POs → exports → Ordorite imports
  // create real POs → THIS SWEEP attaches each real PO to the matching
  // draft PO via BuyerDraftPoRealPoLink. After this, Slice 6.7's panel
  // shows precisely the buyer's PONs, no empirical-join noise.
  results.buyerDraftPoAutoLinked = await autoLinkBuyerDraftPosToRealPos(createdBy ?? null);

  return results;
}

// ---------------------------------------------------------------------------
// Stock-by-item import
// ---------------------------------------------------------------------------

export interface StockByItemImportResult {
  message: string;
  productsCreated: number;
  productsUpdated: number;
  positionsUpserted: number;
  skippedZeroQty: number;
  unmappedLocations: string[];
  /**
   * Slice 5 (2026-05-12): EXPORTED buyer drafts whose barcodes matched
   * a Product UPC in this import run. Auto-flipped to FULFILLED with
   * `fulfilledProductId` populated. Optional — only present when the
   * post-import sweep actually linked something.
   */
  buyerDraftsAutoLinked?: number;
}

// Fallback bucket for stock-by-item rows whose CSV location name doesn't
// match any `StockLocation.name` or `locationAliases` entry. Without this,
// those rows were silently dropped -- a buyer saw 19 units on the Buyers
// Report when the CSV said 37, because 18 were at unrecognized locations
// (see failure log 2026-04-24). Now they land here with the original name
// preserved in `notes` so an admin can reconcile.
const CATCHALL_CODE = "UNMATCHED";
const CATCHALL_NAME = "Unmatched — Needs Review";

async function ensureCatchallStockLocation(): Promise<{
  stockLocationId: number;
  storeLocationId: number;
}> {
  // Try to find an existing catch-all first
  const existing = await prisma.stockLocation.findFirst({
    where: { code: CATCHALL_CODE },
    select: { id: true, storeLocationId: true },
  });
  if (existing) {
    return { stockLocationId: existing.id, storeLocationId: existing.storeLocationId };
  }
  // Create at the Warehouse store (or first active StoreLocation if
  // Warehouse doesn't exist)
  const store =
    (await prisma.storeLocation.findFirst({ where: { name: "Warehouse" } })) ??
    (await prisma.storeLocation.findFirst({ where: { isActive: true } })) ??
    (await prisma.storeLocation.findFirst());
  if (!store) {
    throw new Error("No StoreLocation exists -- cannot create catch-all stock location");
  }
  const created = await prisma.stockLocation.create({
    data: {
      code: CATCHALL_CODE,
      name: CATCHALL_NAME,
      storeLocationId: store.id,
      locationType: "STOCK",
    },
    select: { id: true, storeLocationId: true },
  });
  return { stockLocationId: created.id, storeLocationId: created.storeLocationId };
}

export async function runStockByItemImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<StockByItemImportResult> {
  // Pre-load lookup caches
  const allStockLocations = await prisma.stockLocation.findMany({
    select: { id: true, storeLocationId: true, locationAliases: true },
  });
  const aliasMap = new Map<string, { stockLocationId: number; storeLocationId: number }>();
  for (const sl of allStockLocations) {
    for (const alias of sl.locationAliases) {
      aliasMap.set(alias.toLowerCase(), {
        stockLocationId: sl.id,
        storeLocationId: sl.storeLocationId,
      });
    }
  }
  const catchall = await ensureCatchallStockLocation();

  const allVendors = await prisma.vendor.findMany({ select: { id: true, name: true } });
  const vendorMap = new Map<string, number>();
  for (const v of allVendors) {
    vendorMap.set(v.name.toLowerCase(), v.id);
  }

  const allDepts = await prisma.department.findMany({ select: { id: true, name: true } });
  const deptMap = new Map<string, number>();
  for (const d of allDepts) {
    deptMap.set(d.name.toLowerCase(), d.id);
  }

  const allCats = await prisma.category.findMany({
    select: { id: true, name: true, departmentId: true },
  });
  const catMap = new Map<string, number>();
  for (const c of allCats) {
    catMap.set(`${c.departmentId}:${c.name.toLowerCase()}`, c.id);
  }

  const existingByOrdorite = await prisma.product.findMany({
    where: { externalId: { not: null } },
    select: { id: true, externalId: true },
  });
  const productByExternalId = new Map<number, number>();
  for (const p of existingByOrdorite) {
    if (p.externalId) productByExternalId.set(p.externalId, p.id);
  }

  let productsCreated = 0;
  let productsUpdated = 0;
  let positionsUpserted = 0;
  let skippedZeroQty = 0;
  const unmappedLocations = new Set<string>();
  const userEmail = createdBy || null;

  const SBI_BATCH_SIZE = 100;
  for (let i = 0; i < records.length; i += SBI_BATCH_SIZE) {
    const batch = records.slice(i, i + SBI_BATCH_SIZE);

    await prisma.$transaction(async (tx) => {
      for (const row of batch) {
        const stockId = Number.parseInt(String(row.Stockid || row.stockid || "").trim(), 10);
        if (Number.isNaN(stockId)) continue;

        const partNo = String(row["Part No"] || row.partNo || "").trim();
        const productName = String(row["Product Name"] || row.productName || "").trim();
        const quantity = parseFloat(String(row["On Hand"] || row.onHand || "0").trim());
        const costPrice = parseFloat(String(row["Cost Price"] || row.costPrice || "0").trim());
        const sellingPrice = parseFloat(String(row.SellingPrice || row.sellingPrice || "0").trim());
        const supplierName = String(row.Supplier || row.supplier || "").trim();
        const deptName = String(row.Department || row.department || "").trim();
        const catName = String(row.Category || row.category || "").trim();
        const locationName = String(row.Stocklocation || row.stocklocation || "").trim();
        const barcode = String(row["Barcode No"] || row.barcodeNo || "").trim();

        // Resolve or create vendor
        let vendorId = supplierName ? vendorMap.get(supplierName.toLowerCase()) : undefined;
        if (!vendorId && supplierName) {
          const v = await tx.vendor.create({
            data: { name: supplierName, pricingModel: "FLAT" },
          });
          vendorId = v.id;
          vendorMap.set(supplierName.toLowerCase(), v.id);
        }
        if (!vendorId) {
          let unknown = vendorMap.get("unknown");
          if (!unknown) {
            const v = await tx.vendor.create({
              data: { name: "Unknown", pricingModel: "FLAT" },
            });
            unknown = v.id;
            vendorMap.set("unknown", v.id);
          }
          vendorId = unknown;
        }

        // Resolve or create department
        let departmentId = deptName ? deptMap.get(deptName.toLowerCase()) : undefined;
        if (!departmentId && deptName) {
          const d = await tx.department.create({ data: { name: deptName } });
          departmentId = d.id;
          deptMap.set(deptName.toLowerCase(), d.id);
        }
        if (!departmentId) {
          let uncatDept = deptMap.get("uncategorized");
          if (!uncatDept) {
            const d = await tx.department.create({ data: { name: "Uncategorized" } });
            uncatDept = d.id;
            deptMap.set("uncategorized", d.id);
          }
          departmentId = uncatDept;
        }

        // Resolve or create category
        const catKey = `${departmentId}:${(catName || "general").toLowerCase()}`;
        let categoryId = catMap.get(catKey);
        if (!categoryId) {
          const c = await tx.category.create({
            data: { name: catName || "General", departmentId },
          });
          categoryId = c.id;
          catMap.set(catKey, c.id);
        }

        // Upsert product
        let productId = productByExternalId.get(stockId);
        if (productId) {
          await tx.product.update({
            where: { id: productId },
            data: {
              baseCost: Number.isNaN(costPrice) ? undefined : costPrice,
              baseRetail: Number.isNaN(sellingPrice) ? undefined : sellingPrice,
              departmentId,
              categoryId,
              updatedBy: userEmail,
            },
          });
          productsUpdated++;
        } else {
          const existing = partNo
            ? await tx.product.findFirst({
                where: { productNumber: partNo, vendorId },
                select: { id: true },
              })
            : null;

          if (existing) {
            productId = existing.id;
            await tx.product.update({
              where: { id: productId },
              data: {
                externalId: stockId,
                baseCost: Number.isNaN(costPrice) ? undefined : costPrice,
                baseRetail: Number.isNaN(sellingPrice) ? undefined : sellingPrice,
                updatedBy: userEmail,
              },
            });
            productByExternalId.set(stockId, productId);
            productsUpdated++;
          } else {
            const product = await tx.product.create({
              data: {
                productNumber: partNo || `ORD-${stockId}`,
                name: productName || partNo || `Product ${stockId}`,
                description: String(row.Description || row.description || "").trim() || null,
                baseCost: Number.isNaN(costPrice) ? 0 : costPrice,
                baseRetail: Number.isNaN(sellingPrice) ? null : sellingPrice,
                vendorId,
                departmentId,
                categoryId,
                externalId: stockId,
                createdBy: userEmail,
              },
            });
            productId = product.id;
            productByExternalId.set(stockId, productId);
            productsCreated++;
          }
        }

        // UPC
        if (barcode && barcode !== "0" && productId) {
          await tx.upc.upsert({
            where: { upc: barcode },
            create: { upc: barcode, productId },
            update: {},
          });
        }

        if (quantity === 0) {
          skippedZeroQty++;
          continue;
        }

        if (!locationName) continue;
        const locationMatch = aliasMap.get(locationName.toLowerCase());
        // If no alias matches, route to the catch-all location rather than
        // dropping the row. Preserve the original CSV location name in
        // `notes` so an admin can either (a) add an alias to the real
        // StockLocation, or (b) create the missing StockLocation and
        // reassign. Also track the set of unmapped names for the import
        // result UI.
        const resolved = locationMatch ?? catchall;
        const positionNotes =
          locationMatch == null ? `Unmatched CSV location: ${locationName}` : undefined;
        if (!locationMatch) unmappedLocations.add(locationName);

        const existingPos = await tx.inventoryPosition.findFirst({
          where: {
            productId,
            storeLocationId: resolved.storeLocationId,
            stockLocationId: resolved.stockLocationId,
            salesOrderId: null,
          },
        });

        if (existingPos) {
          await tx.inventoryPosition.update({
            where: { id: existingPos.id },
            data: {
              quantity,
              updatedBy: userEmail,
              ...(positionNotes ? { notes: positionNotes } : {}),
            },
          });
        } else {
          await tx.inventoryPosition.create({
            data: {
              productId,
              storeLocationId: resolved.storeLocationId,
              stockLocationId: resolved.stockLocationId,
              quantity,
              notes: positionNotes,
              createdBy: userEmail,
            },
          });
        }
        positionsUpserted++;
      }
    }, TX_TIMEOUT.LONG);
  }

  const unmappedArr = Array.from(unmappedLocations);

  // Slice 5 (2026-05-12): auto-link buyer drafts whose barcode now matches
  // a Product UPC. Runs OUTSIDE the per-batch transaction — it's
  // idempotent and shouldn't roll back the stock import on failure.
  const buyerDraftsAutoLinked = await autoLinkBuyerDrafts(userEmail);

  const message = buildStockByItemMessage({
    productsCreated,
    productsUpdated,
    positionsUpserted,
    unmappedCount: unmappedArr.length,
    buyerDraftsAutoLinked,
  });

  return {
    message,
    productsCreated,
    productsUpdated,
    positionsUpserted,
    skippedZeroQty,
    unmappedLocations: unmappedArr,
    ...(buyerDraftsAutoLinked > 0 ? { buyerDraftsAutoLinked } : {}),
  };
}

/** Pluralize-and-comma-join helper for the stock import result message.
 * Extracted to (a) keep the parent function under Sonar S3776 complexity
 * threshold and (b) flatten the nested-ternaries S3358 would otherwise flag. */
function buildStockByItemMessage(parts: {
  productsCreated: number;
  productsUpdated: number;
  positionsUpserted: number;
  unmappedCount: number;
  buyerDraftsAutoLinked: number;
}): string {
  const segments: string[] = [
    `${parts.productsCreated} products created`,
    `${parts.productsUpdated} updated`,
    `${parts.positionsUpserted} inventory positions set`,
  ];
  if (parts.unmappedCount > 0) {
    const noun = parts.unmappedCount === 1 ? "location name" : "location names";
    segments.push(`${parts.unmappedCount} unmatched ${noun} routed to "${CATCHALL_NAME}"`);
  }
  if (parts.buyerDraftsAutoLinked > 0) {
    const noun = parts.buyerDraftsAutoLinked === 1 ? "buyer draft" : "buyer drafts";
    segments.push(`${parts.buyerDraftsAutoLinked} ${noun} auto-linked`);
  }
  return segments.join(", ");
}

/**
 * Slice 5 post-import sweep: find every EXPORTED buyer draft whose
 * `barcode` matches a Product UPC, flip the draft to FULFILLED, and
 * stamp `fulfilledProductId` + `fulfilledAt`. Pure planning logic
 * lives in `lib/buyerDraftAutoLink.ts`; this function does the I/O.
 *
 * Idempotent — drafts that are already FULFILLED (or have
 * `fulfilledProductId` set) are excluded by the WHERE clause.
 *
 * Returns the count of drafts auto-linked this run.
 */
async function autoLinkBuyerDrafts(updatedBy: string | null): Promise<number> {
  // Pull every EXPORTED draft with a barcode and no link yet. Small
  // table — full scan is fine (a few hundred rows at most in steady state).
  const drafts = await prisma.buyerDraftItem.findMany({
    where: {
      status: "EXPORTED",
      fulfilledProductId: null,
      barcode: { not: null },
    },
    select: { id: true, barcode: true, status: true, fulfilledProductId: true },
  });
  if (drafts.length === 0) return 0;

  // Build the candidate barcode set, then look up Products via the Upc
  // table (one Product can have multiple UPCs — Marjan rugs especially).
  const candidateBarcodes = drafts
    .map((d) => d.barcode)
    .filter((b): b is string => b !== null && b.trim() !== "");
  if (candidateBarcodes.length === 0) return 0;

  const upcRows = await prisma.upc.findMany({
    where: { upc: { in: candidateBarcodes } },
    select: { upc: true, productId: true },
  });
  const upcIndex: UpcIndex = new Map(upcRows.map((r) => [r.upc, r.productId]));

  const planInput: DraftCandidate[] = drafts.map((d) => ({
    id: d.id,
    barcode: d.barcode ?? "",
    status: d.status,
    fulfilledProductId: d.fulfilledProductId,
  }));
  const plan = planAutoLinks(planInput, upcIndex);
  if (plan.links.length === 0) return 0;

  // Apply: per-row update so we can capture the productId per draft.
  // Plan length is small (matches are rare per run) so the overhead is
  // negligible — clearer than a CASE WHEN raw query.
  const now = new Date();
  for (const link of plan.links) {
    await prisma.buyerDraftItem.update({
      where: { id: link.draftId },
      data: {
        fulfilledProductId: link.productId,
        fulfilledAt: now,
        status: "FULFILLED",
        updatedBy,
      },
    });
  }
  return plan.links.length;
}

/**
 * Slice 6.10 (2026-05-14) — flip BuyerDraftPurchaseOrder.status to
 * FULFILLED for any draft PO whose every linked item now appears on
 * a real PurchaseOrder with status RECEIVED_FULL or RECEIVED_PARTIAL.
 *
 * Runs as a post-import sweep on both `runPurchaseOrdersImport` (the
 * PO file refresh, which can update real PO status) and
 * `runReceivedItemsImport` (the receivings file, which adds new
 * ReceivingRecord rows and can promote a PO to RECEIVED_FULL).
 *
 * Pure planning logic lives in `lib/buyerDraftAutoFulfillPo.ts`; this
 * function does the I/O. Conservative — only flips DRAFT/READY/EXPORTED
 * (not FULFILLED, not CANCELLED). Idempotent — already-FULFILLED POs
 * are filtered by the WHERE clause.
 *
 * Returns the count of draft POs auto-fulfilled this run.
 */
async function autoFulfillBuyerDraftPos(updatedBy: string | null): Promise<number> {
  // Pull every non-terminal draft PO. Small table — full scan is
  // fine (the buyer's draft POs are a few dozen rows at most in
  // steady state).
  const draftPos = await prisma.buyerDraftPurchaseOrder.findMany({
    where: { status: { in: ["DRAFT", "READY", "EXPORTED"] } },
    select: {
      id: true,
      status: true,
      items: { select: { fulfilledProductId: true } },
    },
  });
  if (draftPos.length === 0) return 0;

  // Build the candidate productId set from drafts → products to verify.
  const linkedIds = new Set<number>();
  for (const po of draftPos) {
    for (const it of po.items) {
      if (it.fulfilledProductId !== null) linkedIds.add(it.fulfilledProductId);
    }
  }
  if (linkedIds.size === 0) return 0;

  // Which of these productIds have evidence of receipt? Use the
  // BROAD definition: appears on any PurchaseOrderItem whose parent
  // PO is RECEIVED_FULL or RECEIVED_PARTIAL. A line on a partial PO
  // counts because the item has provably arrived in our warehouse;
  // we don't make the buyer wait for the WHOLE PON to close.
  const receivedRows = await prisma.purchaseOrderItem.findMany({
    where: {
      productId: { in: Array.from(linkedIds) },
      purchaseOrder: { status: { in: ["RECEIVED_FULL", "RECEIVED_PARTIAL"] } },
    },
    select: { productId: true },
  });
  const receivedProductIds = new Set<number>(
    receivedRows.map((r) => r.productId).filter((v): v is number => v !== null && v !== undefined),
  );

  const planInput: DraftPoForAutoFulfill[] = draftPos.map((po) => ({
    id: po.id,
    status: po.status,
    items: po.items.map((it) => ({ fulfilledProductId: it.fulfilledProductId })),
  }));
  const plan = planAutoFulfill(planInput, receivedProductIds);
  if (plan.draftPoIdsToFulfill.length === 0) return 0;

  await prisma.buyerDraftPurchaseOrder.updateMany({
    where: { id: { in: plan.draftPoIdsToFulfill } },
    data: { status: "FULFILLED", updatedBy },
  });

  return plan.draftPoIdsToFulfill.length;
}

/**
 * Slice 6.14 (2026-05-22) — for every real PurchaseOrder that doesn't
 * yet have a BuyerDraftPoRealPoLink row, try to attach it to an
 * existing buyer-draft PO by vendor + item overlap. Single-match only;
 * ambiguous candidates are logged + skipped (operator handles manually).
 *
 * Runs as a post-import sweep at the end of `runPurchaseOrdersImport`.
 * Mirrors the Slice 5 (`autoLinkBuyerDrafts`) wiring pattern: pure
 * planning in `lib/buyerDraftPoAutoLink.ts`, this function does the I/O.
 *
 * Returns the count of links written this run. Idempotent — real POs
 * with an existing link are filtered out by the `buyerDraftLink` check.
 */
async function autoLinkBuyerDraftPosToRealPos(createdBy: string | null): Promise<number> {
  // Pull every real PO that doesn't yet have a buyer-draft link.
  // Scoped to RECENT POs (last 6 months by orderDate) to keep the
  // sweep proportional to import volume — historical POs aren't
  // being newly imported, so they don't need re-checking.
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);

  const realPos = await prisma.purchaseOrder.findMany({
    where: {
      orderDate: { gte: sixMonthsAgo },
      status: { not: "CANCELLED" },
      buyerDraftLink: null,
    },
    select: {
      id: true,
      vendorId: true,
      lineItems: { select: { partNo: true, productId: true } },
    },
  });
  if (realPos.length === 0) return 0;

  // Pull every candidate buyer draft PO + its items.
  const draftPos = await prisma.buyerDraftPurchaseOrder.findMany({
    where: { status: { in: ["DRAFT", "READY", "EXPORTED"] }, vendorId: { not: null } },
    select: {
      id: true,
      vendorId: true,
      status: true,
      items: { select: { partNumber: true, fulfilledProductId: true } },
    },
  });
  if (draftPos.length === 0) return 0;

  const realPoInputs = realPos.map((rp) => ({
    id: rp.id,
    vendorId: rp.vendorId,
    partNos: Array.from(
      new Set(
        rp.lineItems
          .map((l) => l.partNo)
          .filter((pn): pn is string => typeof pn === "string" && pn.length > 0)
          .map((pn) => pn.toLowerCase().trim()),
      ),
    ),
    productIds: Array.from(
      new Set(rp.lineItems.map((l) => l.productId).filter((p): p is number => p !== null)),
    ),
    alreadyLinked: false, // already filtered by the WHERE
  }));

  const draftPoInputs = draftPos
    .filter((dp): dp is typeof dp & { vendorId: number } => dp.vendorId !== null)
    .map((dp) => ({
      id: dp.id,
      vendorId: dp.vendorId,
      status: dp.status,
      partNumbers: Array.from(
        new Set(
          dp.items
            .map((i) => i.partNumber)
            .filter((pn): pn is string => typeof pn === "string" && pn.length > 0)
            .map((pn) => pn.toLowerCase().trim()),
        ),
      ),
      fulfilledProductIds: Array.from(
        new Set(dp.items.map((i) => i.fulfilledProductId).filter((p): p is number => p !== null)),
      ),
    }));

  const plan = planPoAutoLinks(realPoInputs, draftPoInputs);
  if (plan.links.length === 0) return 0;

  // Apply the proposed links. The @unique constraint on realPoId is
  // the final safety net — if two parallel imports race, one wins
  // and the other errors out (we treat that as expected, not fatal).
  let applied = 0;
  for (const link of plan.links) {
    try {
      await prisma.buyerDraftPoRealPoLink.create({
        data: {
          draftPoId: link.draftPoId,
          realPoId: link.realPoId,
          linkSource: "AUTO",
          createdBy,
          updatedBy: createdBy,
        },
      });
      applied++;
    } catch (err) {
      // Likely the unique constraint kicked in from a concurrent
      // import; log + continue.
      logError(
        `[autoLinkBuyerDraftPosToRealPos] could not link realPoId=${link.realPoId} → draftPoId=${link.draftPoId}`,
        err,
      );
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Payments import
// ---------------------------------------------------------------------------

export interface PaymentsImportResult {
  paymentsCreated: number;
  paymentsUpdated: number;
  stubOrdersCreated: number;
  orphanPayments: number;
  ordersPromoted: number;
  phantomTransfersSkipped: number;
  errors: string[];
}

export async function runPaymentsImport(
  paymentData: Record<string, unknown>[],
): Promise<PaymentsImportResult> {
  const results: PaymentsImportResult = {
    paymentsCreated: 0,
    paymentsUpdated: 0,
    stubOrdersCreated: 0,
    orphanPayments: 0,
    ordersPromoted: 0,
    phantomTransfersSkipped: 0,
    errors: [],
  };

  const locationMap = await buildLocationMap();

  for (const row of paymentData) {
    try {
      const orderno = safeString(row["Order Number"]);
      const paymentCode = safeString(row["Payment Code"]);

      if (!paymentCode) {
        results.errors.push("Skipped: missing Payment Code");
        continue;
      }

      // Ordorite's rewrite flow: base order gets a real card payment, then
      // Ordorite creates a credit note for the return and "applies" it to the
      // rewrite. The application shows up in the payments CSV as a
      // paymentType="Gift Card" row on the rewrite order -- with NO gift card
      // barcode or id -- because Ordorite uses that paymentType label for its
      // internal credit-note transfers. It is not a real gift card redemption
      // and the money already lives on the base's card payment. Importing it
      // double-counts the tender and breaks customer balance math. Skip it.
      // See docs/domains/ordorite-import.md "Rewrites -- what the payments
      // really mean" and CLAUDE.md Key Gotchas.
      if (
        orderno &&
        isRewriteOrder(orderno) &&
        resolvePaymentMode(row.Modeofpayment) === "Gift Card" &&
        !safeString(row["Gift Card Barcode"]) &&
        !safeString(row["Gift Card Code"])
      ) {
        results.phantomTransfersSkipped++;
        continue;
      }

      let salesOrderId: number | null = null;

      if (orderno) {
        const existing = await prisma.salesOrder.findUnique({ where: { orderno } });
        if (existing) {
          salesOrderId = existing.id;
        } else {
          const stub = await prisma.salesOrder.create({
            data: {
              orderno,
              // Payment date is not the order date. Leave null so the invoice/sales
              // import can set orderDate correctly when it processes this order.
              orderDate: null,
            },
          });
          salesOrderId = stub.id;
          results.stubOrdersCreated++;
        }
      } else {
        results.orphanPayments++;
      }

      const paymentType = resolvePaymentMode(row.Modeofpayment);
      const amount = safeFloat(row["Payment Amount"]);
      const isRefund = isRefundPayment(paymentType, amount);
      const existingPayment = await prisma.payment.findUnique({ where: { paymentCode } });

      const storeLocationStr = safeString(row.company) || null;
      const paymentFields = {
        salesOrderId,
        paymentDate: safeDate(row["Payment Date"]) || new Date(),
        paymentType,
        paymentAmount: amount,
        isRefund,
        storeLocation: storeLocationStr,
        storeLocationId: locationMap.get((storeLocationStr || "").toLowerCase()) ?? undefined,
      };

      if (existingPayment) {
        await prisma.payment.update({
          where: { paymentCode },
          data: paymentFields,
        });
        results.paymentsUpdated++;
      } else {
        await prisma.payment.create({
          data: { paymentCode, ...paymentFields },
        });
        results.paymentsCreated++;
      }
    } catch (rowErr: unknown) {
      const code = safeString(row["Payment Code"]) || "unknown";
      const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
      results.errors.push(`${code}: ${msg}`);
    }
  }

  // Deposits on quotes do not promote them to ORDER. Only the sales import
  // (which pulls actual invoiced orders) should create ORDER-status records.
  // FM treats a quote with a deposit as still a quote until invoicing.
  results.ordersPromoted = 0;

  return results;
}

// ---------------------------------------------------------------------------
// Invoices import
// ---------------------------------------------------------------------------

export interface InvoicesImportResult {
  invoicesCreated: number;
  invoicesUpdated: number;
  invoiceLineItemsCreated: number;
  ordersNotFound: number;
  ordersPromoted: number;
  errors: string[];
}

export async function runInvoicesImport(
  invoiceData: Record<string, unknown>[],
): Promise<InvoicesImportResult> {
  const results: InvoicesImportResult = {
    invoicesCreated: 0,
    invoicesUpdated: 0,
    invoiceLineItemsCreated: 0,
    ordersNotFound: 0,
    ordersPromoted: 0,
    errors: [],
  };

  // Pre-group rows by invoiceNo so we can sum per-line tax across all lines before
  // upserting. Ordorite's invoice export allocates tax per line item, so we must
  // accumulate across all rows for a given invoice to get the correct total.
  type InvoiceGroup = {
    invoiceDate: Date;
    orderno: string | undefined;
    totalTax: number;
    taxLabel: ReturnType<typeof parseTaxLabel>;
    lines: Array<{ partNo: string | undefined; deliveredQuantity: number }>;
  };

  const groups = new Map<string, InvoiceGroup>();

  for (const row of invoiceData) {
    const invoiceNo = safeString(row["Invoice No"]);
    const invoiceDate = safeDate(row["Invoice Date"]);
    if (!invoiceNo || !invoiceDate) {
      results.errors.push("Skipped: missing Invoice No or Date");
      continue;
    }
    const taxDollars = safeFloat(row["Product/Service Sales Tax"]);
    const taxLabel = parseTaxLabel(row["Tax Amount"]);
    const existing = groups.get(invoiceNo);
    if (existing) {
      existing.totalTax += taxDollars;
      existing.lines.push({
        partNo: safeString(row["Part No"]),
        deliveredQuantity: safeFloat(row["Product/Service Quantity"]),
      });
      if (!existing.taxLabel.districtShortName && !existing.taxLabel.exemptReasonName) {
        existing.taxLabel = taxLabel;
      }
    } else {
      groups.set(invoiceNo, {
        invoiceDate,
        orderno: safeString(row.Memo),
        totalTax: taxDollars,
        taxLabel,
        lines: [
          {
            partNo: safeString(row["Part No"]),
            deliveredQuantity: safeFloat(row["Product/Service Quantity"]),
          },
        ],
      });
    }
  }

  for (const [invoiceNo, group] of groups) {
    const { invoiceDate, orderno, totalTax, taxLabel, lines } = group;

    let taxDistrictId: number | null = null;
    let taxExemptReasonId: number | null = null;

    if (taxLabel.districtShortName) {
      taxDistrictId = await resolveTaxDistrictId(prisma, taxLabel);
    }
    if (taxLabel.exemptReasonName) {
      taxExemptReasonId = await resolveTaxExemptReasonId(prisma, taxLabel.exemptReasonName);
    }

    // Resolve order: try latest rewrite first (- B > - A > base) because
    // rewrites replace the original order and are what gets delivered.
    let salesOrder = null;
    if (orderno) {
      const base = orderno.split(" - ")[0].trim();
      const rewriteSuffixes = [" - D", " - C", " - B", " - A"];
      for (const suffix of rewriteSuffixes) {
        salesOrder = await prisma.salesOrder.findUnique({ where: { orderno: base + suffix } });
        if (salesOrder) break;
      }
      if (!salesOrder) {
        salesOrder = await prisma.salesOrder.findUnique({ where: { orderno: base } });
      }
    }

    if (!salesOrder && orderno) {
      results.ordersNotFound++;
      results.errors.push(`Invoice ${invoiceNo}: order ${orderno} not found`);
      continue;
    }

    if (!salesOrder) {
      results.errors.push(`Invoice ${invoiceNo}: no order reference (Memo empty)`);
      continue;
    }

    const existingInvoice = await prisma.invoice.findUnique({ where: { invoiceNo } });

    const invoice = await prisma.invoice.upsert({
      where: { invoiceNo },
      update: {
        invoiceDate,
        taxAmount: totalTax,
        salesOrderId: salesOrder.id,
      },
      create: {
        invoiceNo,
        invoiceDate,
        taxAmount: totalTax,
        salesOrderId: salesOrder.id,
      },
    });

    if (existingInvoice) {
      results.invoicesUpdated++;
    } else {
      results.invoicesCreated++;
    }

    if (taxDistrictId && !salesOrder.taxDistrictId) {
      await prisma.salesOrder.update({
        where: { id: salesOrder.id },
        data: { taxDistrictId },
      });
    }
    if (taxExemptReasonId && !salesOrder.taxExemptReasonId) {
      await prisma.salesOrder.update({
        where: { id: salesOrder.id },
        data: { taxExemptReasonId },
      });
    }

    for (const { partNo, deliveredQuantity } of lines) {
      if (!partNo) continue;
      const orderLineItem = await prisma.orderLineItem.findFirst({
        where: { salesOrderId: salesOrder.id, partNo },
        orderBy: { id: "asc" },
      });

      if (orderLineItem) {
        await prisma.invoiceLineItem.upsert({
          where: {
            invoiceId_orderLineItemId: {
              invoiceId: invoice.id,
              orderLineItemId: orderLineItem.id,
            },
          },
          update: { deliveredQuantity },
          create: {
            invoiceId: invoice.id,
            orderLineItemId: orderLineItem.id,
            deliveredQuantity,
          },
        });
        results.invoiceLineItemsCreated++;
      }
    }
  }

  const promoted = await prisma.salesOrder.updateMany({
    where: {
      status: { in: ["QUOTE", "ORDER"] },
      invoices: { some: {} },
    },
    data: { status: "FULFILLED", updatedBy: "ordorite-invoice-import" },
  });
  results.ordersPromoted = promoted.count;

  return results;
}

// ---------------------------------------------------------------------------
// Customer import
// ---------------------------------------------------------------------------

export interface CustomerImportResult {
  customersCreated: number;
  customersUpdated: number;
  addressesCreated: number;
  ordersBackLinked: number;
  errors: string[];
}

export async function runCustomerImport(
  customerData: Record<string, unknown>[],
  createdBy?: string,
): Promise<CustomerImportResult> {
  const results: CustomerImportResult = {
    customersCreated: 0,
    customersUpdated: 0,
    addressesCreated: 0,
    ordersBackLinked: 0,
    errors: [],
  };

  const userEmail = createdBy || "automated-customer-import";

  // Process sequentially to avoid dedup race conditions
  for (const row of customerData) {
    try {
      const cuscode = safeString(row.Cuscode);
      const customerName = safeString(row.Customer);
      const email = normalizeEmail(row.Email);
      const phone = safeString(row.Phone);

      if (!cuscode && !customerName) {
        results.errors.push("Skipped: missing Cuscode and Customer");
        continue;
      }

      const isNew =
        cuscode &&
        !(await prisma.customerExternalId.findUnique({ where: { externalId: cuscode } }));

      const customer = await findOrCreateCustomer(prisma, {
        cuscode,
        customerName,
        email: email || undefined,
        phone,
        createdBy: userEmail,
      });

      if (!customer) continue;

      if (isNew) {
        results.customersCreated++;
      } else {
        results.customersUpdated++;
      }

      // Enrich email if the customer record is missing one. Skip the
      // update when the email is already attached to a different
      // customer (Customer.email is @unique) -- happens when two
      // Ordorite customers share an email or a customer was merged
      // upstream. Logging the conflict lets us reconcile manually
      // rather than crashing the whole batch.
      //
      // Skip untrusted-domain emails entirely (failure log 2026-05-05).
      // Salespeople sometimes typed their own staff email when entering
      // customers in Ordorite. Those values aren't actually the
      // customer's email and propagating them caused 138 wrongly-
      // merged customers across ~20 records. isUntrustedMergeEmail
      // covers `@saybrookhome.com`, known typos, and any future
      // internal-domain variant.
      if (email && !customer.email && !isUntrustedMergeEmail(email)) {
        const conflict = await prisma.customer.findUnique({
          where: { email },
          select: { id: true },
        });
        if (conflict && conflict.id !== customer.id) {
          results.errors.push(
            `Email ${email} already attached to customer ${conflict.id}; skipping enrichment for ${customer.id}`,
          );
        } else {
          await prisma.customer.update({
            where: { id: customer.id },
            data: { email, updatedBy: userEmail },
          });
        }
      }

      // Parse and upsert address
      const parsed = parseOrdoriteAddress(row.Address);
      if (parsed) {
        const zip = safeString(row.Zip) || "";
        const existing = await prisma.customerAddress.findFirst({
          where: {
            customerId: customer.id,
            address1: { equals: parsed.address1, mode: "insensitive" },
            city: { equals: parsed.city, mode: "insensitive" },
          },
        });

        if (!existing) {
          await prisma.customerAddress.create({
            data: {
              customerId: customer.id,
              address1: parsed.address1,
              city: parsed.city,
              state: parsed.state,
              zip,
              createdBy: userEmail,
            },
          });
          results.addressesCreated++;
        }
      }
    } catch (rowErr: unknown) {
      const label = safeString(row.Customer) || safeString(row.Cuscode) || "unknown";
      const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
      results.errors.push(`${label}: ${msg}`);
    }
  }

  // Back-link orphaned sales orders to their customers
  const orphanedOrders = await prisma.salesOrder.findMany({
    where: { customerId: null, externalCustomerCode: { not: null } },
    select: { id: true, externalCustomerCode: true },
  });

  for (const order of orphanedOrders) {
    const link = await prisma.customerExternalId.findUnique({
      where: { externalId: order.externalCustomerCode! },
      select: { customerId: true },
    });
    if (link) {
      await prisma.salesOrder.update({
        where: { id: order.id },
        data: { customerId: link.customerId },
      });
      results.ordersBackLinked++;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Received items import (Prior_Day_Received_Items)
// Creates ReceivingRecords and triggers consignment PAID sync.
// ---------------------------------------------------------------------------

export interface ReceivedItemsImportResult {
  receivingRecordsCreated: number;
  receivingRecordsSkipped: number;
  purchaseOrdersCreated: number;
  purchaseOrdersUpdated: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  consignmentBatchesCreated: number;
  consignmentItemsPaid: number;
  /** Slice 6.10 — draft POs auto-flipped to FULFILLED because every
   *  linked product now appears on a real PO with RECEIVED_FULL or
   *  RECEIVED_PARTIAL status (after this receiving file processed). */
  buyerDraftPosAutoFulfilled?: number;
  errors: string[];
}

export async function runReceivedItemsImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<ReceivedItemsImportResult> {
  const results: ReceivedItemsImportResult = {
    receivingRecordsCreated: 0,
    receivingRecordsSkipped: 0,
    purchaseOrdersCreated: 0,
    purchaseOrdersUpdated: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    consignmentBatchesCreated: 0,
    consignmentItemsPaid: 0,
    errors: [],
  };

  const vendorCache = await buildVendorCache();
  const userEmail = createdBy || "auto-import";
  // ReceivingRecord.receiverUserId is a FK to User.id (a CUID), NOT an
  // email. Look up the importing user's id once; fall back to the
  // automation user when the import was kicked off by the cron without
  // a real session.
  const receiverUserId = await resolveImportUserId(userEmail);
  const newlyReceivedPOs = new Map<
    number,
    { poNumber: string; vendorId: number; orderDate: Date }
  >();

  for (const row of records) {
    const porNo = safeString(row["Porno"] || row["porno"]);
    const poNumber = safeString(row["Pono"] || row["pono"]);
    try {
      const giStatus = safeString(row["Gistatus"] || row["gistatus"]);
      if (giStatus?.toLowerCase() !== "received") {
        results.receivingRecordsSkipped++;
        continue;
      }

      if (!poNumber || !porNo) {
        results.errors.push(`[${porNo || "unknown"}]: Missing Pono or Porno`);
        continue;
      }

      const supplierName = safeString(row["Supplier"] || row["supplier"]);
      const vendorId = supplierName ? await findOrCreateVendor(supplierName, vendorCache) : null;
      const orderDate = parseDateFlexible(row["Podate"] || row["podate"]) || new Date();
      const expectedDate = parseDateFlexible(row["Expecteddate"] || row["expecteddate"]);
      const status = derivePOStatus(row["Postatus"] || row["postatus"]);

      const existingPO = await prisma.purchaseOrder.findUnique({ where: { poNumber } });
      let poId: number;
      let poVendorId: number;

      if (existingPO) {
        const wasReceived = existingPO.status === "RECEIVED_FULL";
        const updateData: Record<string, unknown> = { status, updatedBy: userEmail };
        if (expectedDate) updateData.expectedDelivery = expectedDate;
        if (vendorId) updateData.vendorId = vendorId;
        await prisma.purchaseOrder.update({ where: { id: existingPO.id }, data: updateData });
        poId = existingPO.id;
        poVendorId = vendorId || existingPO.vendorId;
        results.purchaseOrdersUpdated++;

        if (status === "RECEIVED_FULL" && !wasReceived) {
          newlyReceivedPOs.set(poId, { poNumber, vendorId: poVendorId, orderDate });
        }
      } else {
        const newPO = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: vendorId || (await ensureUnknownVendorId(prisma)),
            orderDate,
            expectedDelivery: expectedDate,
            status,
            createdBy: userEmail,
          },
        });
        poId = newPO.id;
        poVendorId = newPO.vendorId;
        results.purchaseOrdersCreated++;
        if (status === "RECEIVED_FULL") {
          newlyReceivedPOs.set(poId, { poNumber, vendorId: poVendorId, orderDate });
        }
      }

      // Find or create PO item
      const partNo = safeString(row["Part No"] || row["part_no"]);
      const externalId = safeString(row["Productid"] || row["productid"]);
      const qty = safeFloat(row["Qty"] || row["qty"]);
      const landedCost = safeFloat(row["Landed Cost total"] || row["landed_cost_total"]);
      const unitCost = qty > 0 ? landedCost / qty : landedCost;
      const product = await findProduct(prisma, {
        externalId,
        partNo,
        unitCost,
        autoCreate: !!partNo,
        createdBy: userEmail,
      });

      const existingItem = await prisma.purchaseOrderItem.findUnique({
        where: { externalPorNo: porNo },
      });

      let poItemId: number;
      if (existingItem) {
        await prisma.purchaseOrderItem.update({
          where: { id: existingItem.id },
          data: {
            purchaseOrderId: poId,
            productId: product?.id ?? existingItem.productId,
            orderedQuantity: qty || existingItem.orderedQuantity,
            unitCost: unitCost || Number(existingItem.unitCost),
            partNo: partNo || existingItem.partNo,
          },
        });
        poItemId = existingItem.id;
        results.lineItemsUpdated++;
      } else {
        const newItem = await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId: poId,
            externalPorNo: porNo,
            productId: product?.id ?? null,
            orderedQuantity: qty || 1,
            unitCost,
            partNo,
          },
        });
        poItemId = newItem.id;
        results.lineItemsCreated++;
      }

      // Create ReceivingRecord
      const receivedDate =
        parseDateFlexible(row["Receiveddate"] || row["receiveddate"]) ||
        parseDateFlexible(row["Receiveddate_lines"] || row["receiveddate_lines"]) ||
        new Date();
      const receivedQty = safeFloat(row["Receivedqty"] || row["receivedqty"]);
      const dateStr = receivedDate.toISOString().slice(0, 10).replace(/-/g, "");
      const gipNo = `RCV-${porNo}-${dateStr}`;

      const existingRecord = await prisma.receivingRecord.findUnique({
        where: { externalGipNo_externalPorNo: { externalGipNo: gipNo, externalPorNo: porNo } },
      });

      if (existingRecord) {
        results.receivingRecordsSkipped++;
      } else {
        await prisma.receivingRecord.create({
          data: {
            purchaseOrderItemId: poItemId,
            purchaseOrderId: poId,
            quantityReceived: receivedQty || qty || 1,
            receivedDate,
            receiverUserId,
            externalGipNo: gipNo,
            externalPorNo: porNo,
            lineCost: landedCost,
          },
        });
        results.receivingRecordsCreated++;
      }

      // Link to sales order
      const assignedOrder = safeString(row["Assigned Orderno"] || row["assigned_orderno"]);
      if (assignedOrder) {
        const orderNo = assignedOrder.split(" - ")[0].trim();
        const so = await prisma.salesOrder.findUnique({
          where: { orderno: orderNo },
          select: { id: true },
        });
        if (so) {
          const po = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            select: { salesOrderId: true },
          });
          if (po && !po.salesOrderId) {
            await prisma.purchaseOrder.update({
              where: { id: poId },
              data: { salesOrderId: so.id },
            });
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.errors.push(`[${porNo || poNumber || "unknown"}]: ${message}`);
    }
  }

  // Recalculate PO status: if all line items now have receiving records,
  // mark the PO as RECEIVED_FULL even if Ordorite's CSV didn't say "received."
  // This catches POs where items trickle in across multiple import batches.
  const touchedPOIds = new Set<number>();
  for (const row of records) {
    const poNumber = safeString(row["Pono"] || row["pono"]);
    if (poNumber) {
      const po = await prisma.purchaseOrder.findUnique({
        where: { poNumber },
        select: { id: true, status: true, vendorId: true, orderDate: true, poNumber: true },
      });
      if (po && po.status !== "RECEIVED_FULL" && po.status !== "CANCELLED") {
        touchedPOIds.add(po.id);
      }
    }
  }

  // Safety-net: also re-evaluate every non-terminal PO that already carries
  // receiving records, not just the ones in today's Received_Items batch. A PO
  // whose final receipt landed on a day its number wasn't in the file (an
  // out-of-band receipt, a historical backfill, migration 20260408) would
  // otherwise stay CONFIRMED forever -- present on the received list but never
  // flipped to RECEIVED_FULL, so its status drifts out of sync with reality.
  // The candidate set is small (tens of POs). Marjan flips still route through
  // newlyReceivedPOs below, so the consignment PAID sync fires for them.
  const stragglerPOs = await prisma.purchaseOrder.findMany({
    where: {
      status: { notIn: ["RECEIVED_FULL", "CANCELLED"] },
      receivingRecords: { some: {} },
    },
    select: { id: true },
  });
  for (const po of stragglerPOs) touchedPOIds.add(po.id);

  for (const poId of touchedPOIds) {
    // Zero-qty PO lines from Ordorite are effectively cancelled lines --
    // exclude them from both the denominator and numerator so they can't
    // trap the PO at RECEIVED_PARTIAL forever (GitHub #113, CLAUDE.md rule 39).
    const lines = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: poId, orderedQuantity: { gt: 0 } },
      select: { orderedQuantity: true, receivingRecords: { select: { quantityReceived: true } } },
    });
    if (lines.length === 0) continue;
    const itemCount = lines.length;
    // A line counts as received only when its TOTAL received quantity meets or
    // exceeds the ordered quantity. A single partial-qty receipt does NOT
    // complete the line -- otherwise a PO like PON07479 (38 of 59 units, every
    // line touched by one receipt) reads as fully received and wrongly drops
    // off the inbound report. Quantity-level, not "has any receiving record."
    const receivedItemCount = lines.filter((line) => {
      const received = line.receivingRecords.reduce(
        (sum, r) => sum + Number(r.quantityReceived ?? 0),
        0,
      );
      return received >= Number(line.orderedQuantity);
    }).length;
    const nextStatus = classifyPOReceiptStatus(itemCount, receivedItemCount);
    if (nextStatus === "RECEIVED_FULL") {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: poId },
        select: { status: true, poNumber: true, vendorId: true, orderDate: true },
      });
      if (po && po.status !== "RECEIVED_FULL") {
        await prisma.purchaseOrder.update({
          where: { id: poId },
          data: { status: "RECEIVED_FULL", updatedBy: userEmail },
        });
        // Add to newlyReceivedPOs for consignment payment sync
        if (!newlyReceivedPOs.has(poId)) {
          newlyReceivedPOs.set(poId, {
            poNumber: po.poNumber,
            vendorId: po.vendorId,
            orderDate: po.orderDate,
          });
        }
      }
    } else if (nextStatus === "RECEIVED_PARTIAL") {
      await prisma.purchaseOrder.update({
        where: { id: poId },
        data: { status: "RECEIVED_PARTIAL", updatedBy: userEmail },
      });
    }
  }

  // Consignment PAID sync for newly-received Marjan POs
  for (const [poId, { poNumber, vendorId, orderDate }] of newlyReceivedPOs) {
    const vendorEntry = [...vendorCache.entries()].find(([, id]) => id === vendorId);
    if (!vendorEntry || !vendorEntry[0].includes("marjan")) continue;

    const existingBatch = await prisma.consignmentPaymentBatch.findUnique({
      where: { purchaseOrderId: poId },
    });
    if (existingBatch) continue;

    const poItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: poId },
      select: { partNo: true },
    });
    const customerNumbers = poItems
      .map((item) => (item.partNo ? toMarjanCustomerNumber(item.partNo) : null))
      .filter((cn): cn is string => cn !== null);
    if (customerNumbers.length === 0) continue;

    const soldItems = await prisma.consignmentItem.findMany({
      where: { customerNumber: { in: customerNumbers }, status: "SOLD" },
      select: { id: true, cost: true },
    });
    const creditItems = await prisma.consignmentItem.findMany({
      where: { customerNumber: { in: customerNumbers }, status: "ON_FLOOR" },
      select: { id: true, cost: true },
    });
    const allItems = [...soldItems, ...creditItems];
    if (allItems.length === 0) continue;

    const totalAmount = allItems.reduce((sum, item) => sum + Number(item.cost || 0), 0);
    const batch = await prisma.consignmentPaymentBatch.create({
      data: {
        vendorId,
        batchDate: orderDate,
        periodStart: orderDate,
        periodEnd: orderDate,
        totalAmount,
        itemCount: allItems.length,
        isPaid: true,
        purchaseOrderId: poId,
        notes: `Auto-created from ${poNumber}`,
        createdBy: userEmail,
      },
    });
    results.consignmentBatchesCreated++;

    for (const item of soldItems) {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: { status: "PAID", paidDate: orderDate, consignmentPaymentBatchId: batch.id },
      });
      results.consignmentItemsPaid++;
    }
    for (const item of creditItems) {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "PAID",
          paidDate: orderDate,
          consignmentPaymentBatchId: batch.id,
          creditOwed: true,
        },
      });
      results.consignmentItemsPaid++;
    }
  }

  // Slice 6.10 — same auto-fulfill sweep as runPurchaseOrdersImport.
  // Receivings file may have promoted a PO from CONFIRMED to
  // RECEIVED_PARTIAL / _FULL, which is the trigger.
  results.buyerDraftPosAutoFulfilled = await autoFulfillBuyerDraftPos(createdBy ?? null);

  return results;
}

// ---------------------------------------------------------------------------
// Inbound items import (Saybrook_Home_Inbound_Items)
// Updates ESDs on POs and creates/updates items without POR numbers.
// ---------------------------------------------------------------------------

export interface InboundItemsImportResult {
  purchaseOrdersCreated: number;
  purchaseOrdersUpdated: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  expectedDatesSet: number;
  errors: string[];
}

export async function runInboundItemsImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<InboundItemsImportResult> {
  const results: InboundItemsImportResult = {
    purchaseOrdersCreated: 0,
    purchaseOrdersUpdated: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    expectedDatesSet: 0,
    errors: [],
  };

  const vendorCache = await buildVendorCache();
  const userEmail = createdBy || "auto-import";
  // One timestamp for the whole run so every PO in this export shares it —
  // the inbound report filters to MAX(lastSeenInInboundExport) to show only
  // the latest snapshot.
  const importRunAt = new Date();

  for (const row of records) {
    const poNumber = safeString(row["Pono"] || row["pono"]);
    try {
      if (!poNumber) {
        results.errors.push("Skipped row: missing Pono");
        continue;
      }

      const supplierName = safeString(row["Supplier"] || row["supplier"]);
      const vendorId = supplierName ? await findOrCreateVendor(supplierName, vendorCache) : null;
      const orderDate = parseDateFlexible(row["Podate"] || row["podate"]) || new Date();
      const expectedDate = parseDateFlexible(row["Expecteddate"] || row["expecteddate"]);
      const status = derivePOStatus(row["Postatus"] || row["postatus"]);

      const existingPO = await prisma.purchaseOrder.findUnique({ where: { poNumber } });
      let poId: number;

      if (existingPO) {
        const updateData: Record<string, unknown> = {
          status,
          updatedBy: userEmail,
          // Stamp every PO present in this export. The inbound report shows
          // only POs from the latest run, so received/cancelled POs (which
          // drop off Ordorite's inbound snapshot) fall off automatically.
          lastSeenInInboundExport: importRunAt,
        };
        if (vendorId) updateData.vendorId = vendorId;
        // Always refresh the ESD from the export — Ordorite is authoritative
        // and reschedules it. The old `&& !existingPO.expectedDelivery` guard
        // froze the first ESD forever, so rescheduled POs (Ordorite ESD moved
        // to a later month) kept the stale past date and showed as falsely
        // overdue on the inbound report. Origin: 2026-06-04 PO-aging report.
        if (expectedDate) {
          updateData.expectedDelivery = expectedDate;
          results.expectedDatesSet++;
        }
        await prisma.purchaseOrder.update({ where: { id: existingPO.id }, data: updateData });
        poId = existingPO.id;
        results.purchaseOrdersUpdated++;
      } else {
        const newPO = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: vendorId || (await ensureUnknownVendorId(prisma)),
            orderDate,
            expectedDelivery: expectedDate,
            status,
            lastSeenInInboundExport: importRunAt,
            createdBy: userEmail,
          },
        });
        poId = newPO.id;
        results.purchaseOrdersCreated++;
        if (expectedDate) results.expectedDatesSet++;
      }

      const partNo = safeString(row["Part No"] || row["part_no"]);
      if (!partNo) continue;

      const qty = safeFloat(row["Qty"] || row["qty"]);
      const landedCost = safeFloat(row["Landed Cost total"] || row["landed_cost_total"]);
      const unitCost = qty > 0 ? landedCost / qty : landedCost;
      const product = await findProduct(prisma, undefined, partNo);

      const existingItem = await prisma.purchaseOrderItem.findFirst({
        where: { purchaseOrderId: poId, partNo: { equals: partNo, mode: "insensitive" } },
      });

      if (existingItem) {
        await prisma.purchaseOrderItem.update({
          where: { id: existingItem.id },
          data: {
            productId: product?.id ?? existingItem.productId,
            orderedQuantity: qty || existingItem.orderedQuantity,
            unitCost: unitCost || Number(existingItem.unitCost),
          },
        });
        results.lineItemsUpdated++;
      } else {
        await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId: poId,
            productId: product?.id ?? null,
            orderedQuantity: qty || 1,
            unitCost,
            partNo,
          },
        });
        results.lineItemsCreated++;
      }

      const assignedOrder = safeString(row["Assigned Orderno"] || row["assigned_orderno"]);
      if (assignedOrder) {
        const orderNo = assignedOrder.split(" - ")[0].trim();
        const so = await prisma.salesOrder.findUnique({
          where: { orderno: orderNo },
          select: { id: true },
        });
        if (so) {
          const po = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            select: { salesOrderId: true },
          });
          if (po && !po.salesOrderId) {
            await prisma.purchaseOrder.update({
              where: { id: poId },
              data: { salesOrderId: so.id },
            });
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.errors.push(`[${poNumber || "unknown"}]: ${message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Temp items import (Prior_Day_Temp_Items)
// Creates draft PO items with POR numbers.
// ---------------------------------------------------------------------------

export interface TempItemsImportResult {
  purchaseOrdersCreated: number;
  purchaseOrdersUpdated: number;
  lineItemsCreated: number;
  lineItemsUpdated: number;
  errors: string[];
}

export async function runTempItemsImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<TempItemsImportResult> {
  const results: TempItemsImportResult = {
    purchaseOrdersCreated: 0,
    purchaseOrdersUpdated: 0,
    lineItemsCreated: 0,
    lineItemsUpdated: 0,
    errors: [],
  };

  const vendorCache = await buildVendorCache();
  const userEmail = createdBy || "auto-import";

  for (const row of records) {
    const porNo = safeString(row["Porno"] || row["porno"]);
    const poNumber = safeString(row["Pono"] || row["pono"]);
    try {
      if (!poNumber || !porNo) {
        results.errors.push(`[${porNo || "unknown"}]: Missing Pono or Porno`);
        continue;
      }

      const supplierName = safeString(row["Supplier"] || row["supplier"]);
      const vendorId = supplierName ? await findOrCreateVendor(supplierName, vendorCache) : null;
      const orderDate = parseDateFlexible(row["Podate"] || row["podate"]) || new Date();
      const expectedDate = parseDateFlexible(row["Expecteddate"] || row["expecteddate"]);

      const existingPO = await prisma.purchaseOrder.findUnique({ where: { poNumber } });
      let poId: number;

      if (existingPO) {
        const updateData: Record<string, unknown> = { updatedBy: userEmail };
        if (vendorId) updateData.vendorId = vendorId;
        if (expectedDate) updateData.expectedDelivery = expectedDate;
        await prisma.purchaseOrder.update({ where: { id: existingPO.id }, data: updateData });
        poId = existingPO.id;
        results.purchaseOrdersUpdated++;
      } else {
        // Status from Ordorite's Postatus column. The temp report
        // typically sends `Postatus = "Temporary"` which maps to
        // DRAFT via PO_STATUS_MAP. Pre-2026-05-21 this was hardcoded
        // to CONFIRMED — the runner had never delivered (router
        // mismatch) so no real history was affected, but the moment
        // PR #314's rename landed it would have. Mirror the 3 other
        // PO-creating runners (lines 1237, 2466, 2787) which already
        // use derivePOStatus.
        const status = derivePOStatus(row["Postatus"] || row["postatus"]);
        const newPO = await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId: vendorId || (await ensureUnknownVendorId(prisma)),
            orderDate,
            expectedDelivery: expectedDate,
            status,
            createdBy: userEmail,
          },
        });
        poId = newPO.id;
        results.purchaseOrdersCreated++;
      }

      const partNo = safeString(row["Part No"] || row["part_no"]);
      const externalId = safeString(row["Productid"] || row["productid"]);
      const qty = safeFloat(row["Qty"] || row["qty"]);
      const landedCost = safeFloat(row["Landed Cost total"] || row["landed_cost_total"]);
      const unitCost = qty > 0 ? landedCost / qty : landedCost;
      const product = await findProduct(prisma, {
        externalId,
        partNo,
        unitCost,
        autoCreate: !!partNo,
        createdBy: userEmail,
      });

      const existingItem = await prisma.purchaseOrderItem.findUnique({
        where: { externalPorNo: porNo },
      });

      if (existingItem) {
        await prisma.purchaseOrderItem.update({
          where: { id: existingItem.id },
          data: {
            purchaseOrderId: poId,
            productId: product?.id ?? existingItem.productId,
            orderedQuantity: qty || existingItem.orderedQuantity,
            unitCost: unitCost || Number(existingItem.unitCost),
            partNo: partNo || existingItem.partNo,
          },
        });
        results.lineItemsUpdated++;
      } else {
        await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId: poId,
            externalPorNo: porNo,
            productId: product?.id ?? null,
            orderedQuantity: qty || 1,
            unitCost,
            partNo,
          },
        });
        results.lineItemsCreated++;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.errors.push(`[${porNo || poNumber || "unknown"}]: ${message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// PO Line Export import (SH_Purchase_Order_Line_Export)
// Items filtered to "To Be Ordered" — have POR# but no PON yet.
// Updates existing PO items with product links and sales order references.
// ---------------------------------------------------------------------------

export interface POLineExportImportResult {
  lineItemsUpdated: number;
  skipped: number;
  errors: string[];
}

function parsePorFromId(id: string): string | null {
  if (!id) return null;
  if (id.toUpperCase().startsWith("POR")) return id.toUpperCase();
  const base = id.split("/")[0].trim();
  if (!base || !/^\d+$/.test(base)) return null;
  return `POR${base}`;
}

export async function runPOLineExportImport(
  records: Record<string, unknown>[],
  createdBy?: string,
): Promise<POLineExportImportResult> {
  const userEmail = createdBy || "auto-import";
  const results: POLineExportImportResult = {
    lineItemsUpdated: 0,
    skipped: 0,
    errors: [],
  };

  for (const row of records) {
    const rawId = safeString(row["Id"] || row["id"]);
    try {
      const porNo = parsePorFromId(rawId || "");
      if (!porNo) {
        results.skipped++;
        continue;
      }

      // Only process items without a PON (To Be Ordered)
      const poNumber = safeString(row["Pono"] || row["pono"]);
      if (poNumber && poNumber.startsWith("PON")) {
        results.skipped++;
        continue;
      }

      const partNo = safeString(row["Part No"] || row["part_no"]);
      const externalId = safeString(row["Productid"] || row["productid"]);
      const qty = safeFloat(row["Totalqty"] || row["totalqty"]);
      const product = await findProduct(prisma, {
        externalId,
        partNo,
        autoCreate: !!partNo,
        createdBy: userEmail,
      });

      // Can only update existing items (no PO to create items under)
      const existingItem = await prisma.purchaseOrderItem.findUnique({
        where: { externalPorNo: porNo },
      });

      if (!existingItem) {
        results.skipped++;
        continue;
      }

      await prisma.purchaseOrderItem.update({
        where: { id: existingItem.id },
        data: {
          productId: product?.id ?? existingItem.productId,
          orderedQuantity: qty || existingItem.orderedQuantity,
          partNo: partNo || existingItem.partNo,
        },
      });
      results.lineItemsUpdated++;

      // Link to sales order via Reference
      const reference = safeString(row["Reference"] || row["reference"]);
      if (reference && !existingItem.orderLineItemId) {
        const orderNo = reference.split(" - ")[0].trim();
        if (orderNo) {
          const so = await prisma.salesOrder.findUnique({
            where: { orderno: orderNo },
            select: { id: true },
          });
          if (so) {
            const orderLine = await prisma.orderLineItem.findFirst({
              where: { salesOrderId: so.id, productId: product?.id ?? undefined },
              select: { id: true },
            });
            if (orderLine) {
              await prisma.purchaseOrderItem.update({
                where: { id: existingItem.id },
                data: { orderLineItemId: orderLine.id },
              });
            }
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.errors.push(`[${rawId || "unknown"}]: ${message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Products import (SH Item Export / manual Ordorite products CSV)
// ---------------------------------------------------------------------------
// The same runner backs the daily Gmail auto-import (`SH_Item_Export` —
// ~100K rows) AND the manual admin upload at /admin/import/ordorite-products
// (any chunk size the UI feeds it). Column aliases cover both shapes:
//
//   manual CSV historical: id, part_no, Product_name, description,
//     cost_price, selling_price, Supplier, department, category, Type,
//     Family, length, width, height, weight, Barcode
//
//   SH Item Export 2026-05-26+: Id, Part No, Product Name, Product
//     Description, Purchasing Cost, Selling Price, Supplier, Department,
//     Category, Categorytype, Product Family, Item Length, Item Width,
//     Item Height, Barcode No, Active
//
// Active=yes (case-insensitive) sets isActive=true + isDiscontinued=false on
// existing products — used by the daily export to reactivate anything an
// operator inadvertently inactivated. Active=no flips the other direction.
// Absent/empty Active leaves the flags untouched (manual UI behavior).
//
// Self-chunks 500 rows per DB transaction to stay under Postgres parameter
// limits and per-tx memory pressure. With 100K rows that's 200 batches.

const PRODUCTS_IMPORT_CHUNK_SIZE = 500;
const PRODUCTS_IMPORT_UNKNOWN_VENDOR = "Unknown Vendor";
const PRODUCTS_IMPORT_UNCATEGORIZED_DEPT = "Uncategorized";
const PRODUCTS_IMPORT_UNCATEGORIZED_CAT = "Uncategorized";

export interface ProductsImportResult {
  productsCreated: number;
  productsUpdated: number;
  skippedInactiveCount: number;
  upcsCreated: number;
  upcsUpdated: number;
  lineItemsRelinked: number;
  elapsedMs: number;
  errors: string[];
}

export interface ProductsImportOptions {
  /**
   * Manual UI checkbox — when true, products already marked inactive or
   * discontinued in the DB are skipped on update so operator overrides
   * survive re-import. The Gmail auto-import passes false because every
   * row in the SH Item Export is by definition active (Ordorite omits
   * discontinued products from the export).
   */
  skipInactive?: boolean;
}

interface PreparedProductRow {
  externalId: number;
  productNumber: string;
  name: string;
  description?: string;
  season?: string;
  baseCost: number;
  baseRetail: number;
  vendorId: number;
  departmentId: number;
  categoryId: number;
  typeId: number | null;
  length?: number;
  width?: number;
  height?: number;
  weight?: number;
  barcode?: string;
  /**
   * Active flag from the row, normalized to true/false/undefined.
   * undefined = column absent or blank (don't touch existing flags).
   */
  activeFlag: boolean | undefined;
}

interface ProductsImportTaxonomyCache {
  vendorCache: Map<string, number>;
  departmentCache: Map<string, number>;
  categoryCache: Map<string, number>;
  typeCache: Map<string, number>;
}

async function loadProductsImportTaxonomy(): Promise<ProductsImportTaxonomyCache> {
  const [vendors, departments, categories, types] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.category.findMany({ select: { id: true, name: true, departmentId: true } }),
    prisma.type.findMany({ select: { id: true, name: true, categoryId: true } }),
  ]);
  return {
    vendorCache: new Map(vendors.map((v) => [v.name.toLowerCase(), v.id])),
    departmentCache: new Map(departments.map((d) => [d.name.toLowerCase(), d.id])),
    categoryCache: new Map(
      categories.map((c) => [`${c.departmentId}:${c.name.toLowerCase()}`, c.id]),
    ),
    typeCache: new Map(types.map((t) => [`${t.categoryId}:${t.name.toLowerCase()}`, t.id])),
  };
}

async function ensureProductsImportVendor(
  name: string,
  cache: Map<string, number>,
): Promise<number> {
  const key = name.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;
  const created = await prisma.vendor.create({ data: { name, pricingModel: "FLAT" } });
  cache.set(key, created.id);
  return created.id;
}

async function ensureProductsImportDepartment(
  name: string,
  cache: Map<string, number>,
): Promise<number> {
  const key = name.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;
  const created = await prisma.department.create({ data: { name } });
  cache.set(key, created.id);
  return created.id;
}

async function ensureProductsImportCategory(
  name: string,
  departmentId: number,
  cache: Map<string, number>,
): Promise<number> {
  const key = `${departmentId}:${name.toLowerCase()}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const created = await prisma.category.create({
    data: { name, departmentId, trackInventory: true },
  });
  cache.set(key, created.id);
  return created.id;
}

async function ensureProductsImportType(
  name: string,
  categoryId: number,
  cache: Map<string, number>,
): Promise<number> {
  const key = `${categoryId}:${name.toLowerCase()}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const created = await prisma.type.create({ data: { name, categoryId } });
  cache.set(key, created.id);
  return created.id;
}

/**
 * Pure parser for the Active column. Exported for test reuse.
 * "yes" → true, "no" → false, "" / unknown → undefined (leave flags alone).
 */
export function parseProductsImportActiveFlag(raw: string): boolean | undefined {
  const v = (raw || "").trim().toLowerCase();
  if (v === "yes" || v === "y" || v === "true" || v === "1") return true;
  if (v === "no" || v === "n" || v === "false" || v === "0") return false;
  return undefined;
}

interface ProcessProductsChunkResult {
  createdCount: number;
  updatedCount: number;
  skippedInactiveCount: number;
  upcsCreated: number;
  upcsUpdated: number;
  errors: string[];
  /** Part numbers + barcodes from this chunk — used for the post-import relink. */
  relinkScope: string[];
}

type ProductCreateData = Omit<PreparedProductRow, "activeFlag" | "barcode"> & {
  isActive?: boolean;
  isDiscontinued?: boolean;
};

function buildProductData(p: PreparedProductRow): ProductCreateData {
  const base: ProductCreateData = {
    externalId: p.externalId,
    productNumber: p.productNumber,
    name: p.name,
    description: p.description,
    season: p.season,
    baseCost: p.baseCost,
    baseRetail: p.baseRetail,
    vendorId: p.vendorId,
    departmentId: p.departmentId,
    categoryId: p.categoryId,
    typeId: p.typeId,
    length: p.length,
    width: p.width,
    height: p.height,
    weight: p.weight,
  };
  // Active flag — true reactivates (clears isDiscontinued); false flips
  // isActive off. undefined leaves both flags at schema default / current
  // DB value (manual-upload legacy behavior).
  if (p.activeFlag === true) {
    base.isActive = true;
    base.isDiscontinued = false;
  } else if (p.activeFlag === false) {
    base.isActive = false;
  }
  return base;
}

async function fetchExistingProducts(
  externalIds: number[],
): Promise<
  Map<number, { id: number; externalId: number | null; isActive: boolean; isDiscontinued: boolean }>
> {
  const existing = await prisma.product.findMany({
    where: { externalId: { in: externalIds } },
    select: { id: true, externalId: true, isActive: true, isDiscontinued: true },
  });
  return new Map(existing.map((p) => [p.externalId ?? 0, p]));
}

async function refetchProductIds(externalIds: number[]): Promise<Map<number, number>> {
  const allProducts = await prisma.product.findMany({
    where: { externalId: { in: externalIds } },
    select: { id: true, externalId: true },
  });
  return new Map(allProducts.map((p) => [p.externalId ?? 0, p.id]));
}

interface ClassifiedPrepared {
  toCreate: PreparedProductRow[];
  toUpdate: { productId: number; row: PreparedProductRow }[];
  skippedInactiveCount: number;
}

function classifyPrepared(
  prepared: PreparedProductRow[],
  existingByOrdId: Map<number, { id: number; isActive: boolean; isDiscontinued: boolean }>,
  options: ProductsImportOptions,
): ClassifiedPrepared {
  const toCreate: PreparedProductRow[] = [];
  const toUpdate: { productId: number; row: PreparedProductRow }[] = [];
  let skippedInactiveCount = 0;
  for (const p of prepared) {
    const existingRow = existingByOrdId.get(p.externalId);
    if (!existingRow) {
      toCreate.push(p);
      continue;
    }
    if (options.skipInactive && (!existingRow.isActive || existingRow.isDiscontinued)) {
      skippedInactiveCount++;
      continue;
    }
    toUpdate.push({ productId: existingRow.id, row: p });
  }
  return { toCreate, toUpdate, skippedInactiveCount };
}

async function runProductsBulkCreate(
  toCreate: PreparedProductRow[],
  errors: string[],
): Promise<number> {
  if (toCreate.length === 0) return 0;
  try {
    const result = await prisma.product.createMany({
      data: toCreate.map(buildProductData),
      skipDuplicates: true,
    });
    return result.count;
  } catch (bulkErr) {
    logger.warn("products createMany failed, falling back to per-row create", {
      error: bulkErr instanceof Error ? bulkErr.message : String(bulkErr),
      chunkSize: toCreate.length,
    });
    let created = 0;
    for (const p of toCreate) {
      try {
        await prisma.product.create({ data: buildProductData(p) });
        created++;
      } catch (rowErr) {
        const msg = rowErr instanceof Error ? rowErr.message : "unknown";
        errors.push(`[${p.productNumber}] create failed: ${msg}`);
      }
    }
    return created;
  }
}

async function runProductsBulkUpdate(
  toUpdate: { productId: number; row: PreparedProductRow }[],
  errors: string[],
): Promise<number> {
  if (toUpdate.length === 0) return 0;
  const updateOps = toUpdate.map(({ productId, row }) =>
    prisma.product.update({ where: { id: productId }, data: buildProductData(row) }),
  );
  try {
    await prisma.$transaction(updateOps);
    return toUpdate.length;
  } catch (bulkErr) {
    logger.warn("products $transaction(update) failed, falling back to per-row update", {
      error: bulkErr instanceof Error ? bulkErr.message : String(bulkErr),
      chunkSize: toUpdate.length,
    });
    let updated = 0;
    for (const { productId, row } of toUpdate) {
      try {
        await prisma.product.update({ where: { id: productId }, data: buildProductData(row) });
        updated++;
      } catch (rowErr) {
        const msg = rowErr instanceof Error ? rowErr.message : "unknown";
        errors.push(`[${row.productNumber}] update failed: ${msg}`);
      }
    }
    return updated;
  }
}

async function syncProductUpcs(
  prepared: PreparedProductRow[],
  finalByOrdId: Map<number, number>,
): Promise<{ upcsCreated: number; upcsUpdated: number }> {
  const rowsWithBarcodes = prepared.filter((p) => p.barcode);
  if (rowsWithBarcodes.length === 0) return { upcsCreated: 0, upcsUpdated: 0 };

  const existingUpcs = await prisma.upc.findMany({
    where: { upc: { in: rowsWithBarcodes.map((p) => p.barcode!) } },
    select: { upc: true, productId: true },
  });
  const existingUpcMap = new Map(existingUpcs.map((u) => [u.upc, u.productId]));

  const upcCreates: { upc: string; productId: number }[] = [];
  const upcUpdates: { upc: string; productId: number }[] = [];
  for (const p of rowsWithBarcodes) {
    const productId = finalByOrdId.get(p.externalId);
    if (!productId) continue;
    const currentProductId = existingUpcMap.get(p.barcode!);
    if (currentProductId === undefined) {
      upcCreates.push({ upc: p.barcode!, productId });
    } else if (currentProductId !== productId) {
      upcUpdates.push({ upc: p.barcode!, productId });
    }
  }

  if (upcCreates.length > 0) {
    await prisma.upc.createMany({
      data: upcCreates.map((u) => ({
        upc: u.upc,
        productId: u.productId,
        sortOrder: 0,
        source: "ORDORITE",
      })),
      skipDuplicates: true,
    });
  }
  if (upcUpdates.length > 0) {
    const updateOps = upcUpdates.map((u) =>
      prisma.upc.update({
        where: { upc: u.upc },
        data: { productId: u.productId, source: "ORDORITE" },
      }),
    );
    await prisma.$transaction(updateOps);
  }
  return { upcsCreated: upcCreates.length, upcsUpdated: upcUpdates.length };
}

function buildRelinkScope(prepared: PreparedProductRow[]): string[] {
  return Array.from(
    new Set([
      ...prepared.map((p) => p.productNumber),
      ...prepared.map((p) => p.barcode).filter((b): b is string => !!b),
    ]),
  );
}

async function prepareProductRow(
  row: Record<string, unknown>,
  taxonomy: ProductsImportTaxonomyCache,
): Promise<PreparedProductRow | { error: string }> {
  const externalIdRaw = safeString(getCellValue(row, ["id", "Id", "OrdoriteID"])) ?? "";
  const externalId = Number.parseInt(externalIdRaw);
  const partNo =
    safeString(getCellValue(row, ["part_no", "partNo", "Part No", "ProductNumber"])) ?? "";

  if (!externalIdRaw || Number.isNaN(externalId)) {
    return { error: `[${partNo || "unknown"}]: Missing or invalid Ordorite ID` };
  }
  if (!partNo) {
    return { error: `[id:${externalId}]: Missing product number` };
  }

  const productName =
    safeString(
      getCellValue(row, ["Product_name", "ProductName", "product_name", "Product Name", "name"]),
    ) || partNo;

  const supplierName =
    safeString(getCellValue(row, ["Supplier", "supplier", "Vendor"])) ||
    PRODUCTS_IMPORT_UNKNOWN_VENDOR;
  const vendorId = await ensureProductsImportVendor(supplierName, taxonomy.vendorCache);

  const deptName =
    safeString(getCellValue(row, ["department", "Department"])) ||
    PRODUCTS_IMPORT_UNCATEGORIZED_DEPT;
  const departmentId = await ensureProductsImportDepartment(deptName, taxonomy.departmentCache);

  const catName =
    safeString(getCellValue(row, ["category", "Category", "SubFamily"])) ||
    PRODUCTS_IMPORT_UNCATEGORIZED_CAT;
  const categoryId = await ensureProductsImportCategory(
    catName,
    departmentId,
    taxonomy.categoryCache,
  );

  // "Categorytype" is the SH Item Export header; "Type"/"type" cover
  // the older manual upload + legacy variant.
  const typeName = safeString(getCellValue(row, ["Categorytype", "Type", "type"]));
  const typeId = typeName
    ? await ensureProductsImportType(typeName, categoryId, taxonomy.typeCache)
    : null;

  // "0" is an Ordorite placeholder for "no barcode" — treat as blank.
  const barcodeRaw = safeString(
    getCellValue(row, ["Barcode No", "Barcode", "barcode", "BARCODE", "UPC"]),
  );
  const barcode = barcodeRaw && barcodeRaw !== "0" && barcodeRaw !== "0.0" ? barcodeRaw : undefined;

  return {
    externalId,
    productNumber: partNo,
    name: productName,
    description:
      safeString(getCellValue(row, ["description", "Description", "Product Description"])) ||
      undefined,
    season:
      safeString(getCellValue(row, ["Family", "Season", "season", "Product Family"])) || undefined,
    baseCost: safeFloat(getCellValue(row, ["cost_price", "Cost", "cost", "Purchasing Cost"])),
    baseRetail: safeFloat(
      getCellValue(row, ["selling_price", "RetailPrice", "retail_price", "Selling Price"]),
    ),
    vendorId,
    departmentId,
    categoryId,
    typeId,
    length: safeFloat(getCellValue(row, ["length", "Length", "Item Length"])) || undefined,
    width: safeFloat(getCellValue(row, ["width", "Width", "Item Width"])) || undefined,
    height: safeFloat(getCellValue(row, ["height", "Height", "Item Height"])) || undefined,
    // Weight is NOT in the SH Item Export — Ordorite doesn't capture
    // it on their product master. Manual imports may still set it.
    weight: safeFloat(getCellValue(row, ["weight", "Weight"])) || undefined,
    barcode,
    activeFlag: parseProductsImportActiveFlag(
      safeString(getCellValue(row, ["Active", "active"])) ?? "",
    ),
  };
}

async function processProductsImportChunk(
  records: Record<string, unknown>[],
  taxonomy: ProductsImportTaxonomyCache,
  options: ProductsImportOptions,
): Promise<ProcessProductsChunkResult> {
  const errors: string[] = [];
  const prepared: PreparedProductRow[] = [];

  for (const row of records) {
    const partNoHint =
      safeString(getCellValue(row, ["part_no", "partNo", "Part No", "ProductNumber"])) ?? "unknown";
    try {
      const result = await prepareProductRow(row, taxonomy);
      if ("error" in result) {
        errors.push(result.error);
      } else {
        prepared.push(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`[${partNoHint}]: ${msg}`);
    }
  }

  if (prepared.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
      skippedInactiveCount: 0,
      upcsCreated: 0,
      upcsUpdated: 0,
      errors,
      relinkScope: [],
    };
  }

  const externalIds = prepared.map((p) => p.externalId);
  const existingByOrdId = await fetchExistingProducts(externalIds);
  const { toCreate, toUpdate, skippedInactiveCount } = classifyPrepared(
    prepared,
    existingByOrdId,
    options,
  );

  const createdCount = await runProductsBulkCreate(toCreate, errors);
  const updatedCount = await runProductsBulkUpdate(toUpdate, errors);

  const finalByOrdId = await refetchProductIds(externalIds);
  const { upcsCreated, upcsUpdated } = await syncProductUpcs(prepared, finalByOrdId);

  const relinkScope = buildRelinkScope(prepared);

  return {
    createdCount,
    updatedCount,
    skippedInactiveCount,
    upcsCreated,
    upcsUpdated,
    errors,
    relinkScope,
  };
}

export async function runProductsImport(
  records: Record<string, unknown>[],
  // Reserved for parity with other runners — Product import has no
  // createdBy/updatedBy audit fields today, but the runner signature
  // matches sister runners (runSalesImport et al) so the orchestrator
  // can call it uniformly.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _createdBy?: string,
  options: ProductsImportOptions = {},
): Promise<ProductsImportResult> {
  const t0 = Date.now();
  const result: ProductsImportResult = {
    productsCreated: 0,
    productsUpdated: 0,
    skippedInactiveCount: 0,
    upcsCreated: 0,
    upcsUpdated: 0,
    lineItemsRelinked: 0,
    elapsedMs: 0,
    errors: [],
  };

  if (!Array.isArray(records) || records.length === 0) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  // Taxonomy is loaded once for the whole run, not per chunk — vendor /
  // department / category sets don't change mid-import.
  const taxonomy = await loadProductsImportTaxonomy();
  const relinkScopeSet = new Set<string>();

  for (let offset = 0; offset < records.length; offset += PRODUCTS_IMPORT_CHUNK_SIZE) {
    const chunk = records.slice(offset, offset + PRODUCTS_IMPORT_CHUNK_SIZE);
    const chunkResult = await processProductsImportChunk(chunk, taxonomy, options);
    result.productsCreated += chunkResult.createdCount;
    result.productsUpdated += chunkResult.updatedCount;
    result.skippedInactiveCount += chunkResult.skippedInactiveCount;
    result.upcsCreated += chunkResult.upcsCreated;
    result.upcsUpdated += chunkResult.upcsUpdated;
    result.errors.push(...chunkResult.errors);
    for (const scope of chunkResult.relinkScope) relinkScopeSet.add(scope);
  }

  // One relink at the end across the full scope — saves N-1 redundant
  // backfill scans on a 100K-row import.
  if (relinkScopeSet.size > 0) {
    try {
      const relink = await backfillLineItemProductLinks({
        partNos: Array.from(relinkScopeSet),
      });
      result.lineItemsRelinked = relink.updated;
    } catch (err) {
      logError("post-products-import relink failed", err);
    }
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}
