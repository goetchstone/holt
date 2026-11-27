// /app/src/lib/purchasing/importedPurchaseOrder.ts
//
// Writing a purchase order read from a vendor's own document (an order
// confirmation or an invoice PDF), for the upload routes that do it.
//
// A document can be imported again when the vendor revises it. Until 2026-11-27
// each route then deleted the PO holding that number and wrote a new one:
// whichever vendor it belonged to and whatever its status, taking its freight
// charges and buyer-draft link with it, unlinking service cases and the sale
// lines it was ordered for, and bringing a cancelled PO back as confirmed. Only
// a PO with receipts was safe, because the database refused the delete, and
// the screen then said "Import failed".
//
// Now a re-import changes only a PO it could have written and nothing has been
// built on (poReplaceProblem), and changes it in place. The row stays, so its
// id, charges and links stay; its lines become the document's.

import type { Prisma } from "@prisma/client";
import { poReplaceProblem } from "@/lib/purchasing/purchaseOrderShared";
import { PurchaseOrderError } from "@/lib/purchasing/stockPurchaseOrder";

type Tx = Prisma.TransactionClient;

export interface ImportedPoLine {
  productId: number;
  productVariantId: number | null;
  partNo: string;
  productName: string;
  orderedQuantity: number;
  unitCost: number;
}

export interface ImportedPo {
  poNumber: string;
  vendorId: number;
  orderDate: Date;
  expectedDelivery: Date | null;
  vendorAckNumber: string | null;
  /** Null when the document carries none: a replaced PO then keeps the notes it has. */
  notes: string | null;
  lines: ImportedPoLine[];
  actor: string;
}

/**
 * The PO that importing this number again would replace, or null when the
 * number is free. Throws a 409 that says why when the PO holding the number
 * can't be replaced. Call it before writing anything else in the transaction,
 * so a refused import has done nothing.
 */
export async function importReplaceTarget(
  tx: Tx,
  poNumber: string,
  vendor: { id: number; name: string },
): Promise<number | null> {
  const po = await tx.purchaseOrder.findUnique({
    where: { poNumber },
    select: {
      id: true,
      poNumber: true,
      status: true,
      isReturn: true,
      vendorId: true,
      salesOrderId: true,
      dropShipAddressId: true,
      vendor: { select: { name: true } },
      consignmentPaymentBatch: { select: { id: true } },
      _count: { select: { receivingRecords: true } },
      // One is enough to know a line was ordered for a sale's line.
      lineItems: { where: { orderLineItemId: { not: null } }, select: { id: true }, take: 1 },
    },
  });
  if (!po) return null;
  const problem = poReplaceProblem(
    {
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      vendorName: po.vendor.name,
      status: po.status,
      isReturn: po.isReturn,
      receivedCount: po._count.receivingRecords,
      forSale: po.salesOrderId !== null || po.dropShipAddressId !== null || po.lineItems.length > 0,
      forConsignmentPayment: po.consignmentPaymentBatch !== null,
    },
    vendor,
  );
  if (problem) throw new PurchaseOrderError(problem, 409);
  return po.id;
}

/**
 * Write the document's PO, confirmed: a new one, or (`replaceId`, from
 * importReplaceTarget) the same PO with the document's lines in place of its own.
 */
export async function writeImportedPo(
  tx: Tx,
  replaceId: number | null,
  po: ImportedPo,
): Promise<{ id: number; poNumber: string; lineCount: number }> {
  const lines = po.lines.map((line) => ({
    productId: line.productId,
    productVariantId: line.productVariantId,
    partNo: line.partNo,
    productName: line.productName,
    orderedQuantity: line.orderedQuantity,
    unitCost: line.unitCost,
  }));
  const header = {
    orderDate: po.orderDate,
    expectedDelivery: po.expectedDelivery,
    vendorAckNumber: po.vendorAckNumber,
    status: "CONFIRMED" as const,
  };

  if (replaceId === null) {
    const created = await tx.purchaseOrder.create({
      data: {
        ...header,
        poNumber: po.poNumber,
        vendorId: po.vendorId,
        notes: po.notes,
        createdBy: po.actor,
        lineItems: { create: lines },
      },
      select: { id: true, poNumber: true },
    });
    return { ...created, lineCount: lines.length };
  }

  // Re-checked at the write, as the PO editor does: a receipt that landed since
  // importReplaceTarget looked means the lines are no longer ours to change.
  const received = await tx.receivingRecord.count({ where: { purchaseOrderId: replaceId } });
  if (received > 0) {
    throw new PurchaseOrderError(
      `PO ${po.poNumber} was not replaced, and nothing was changed. This PO can't be changed: goods have been received against it.`,
      409,
    );
  }
  await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: replaceId } });
  const updated = await tx.purchaseOrder.update({
    where: { id: replaceId },
    data: {
      ...header,
      ...(po.notes === null ? {} : { notes: po.notes }),
      updatedBy: po.actor,
      lineItems: { create: lines },
    },
    select: { id: true, poNumber: true },
  });
  return { ...updated, lineCount: lines.length };
}
