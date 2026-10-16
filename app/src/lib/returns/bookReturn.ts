// /app/src/lib/returns/bookReturn.ts
//
// A native return books as its OWN RETURNED order the first time money moves
// for it (ledger plan PR 2b; DECISIONS #20). The original order is never
// rewritten: its lines, its invoice and the day it was recognised stay as
// they were, and the return reverses them on the day it happens, exactly as
// an imported POS return does (a separate order of negative lines,
// journalEntry.ts's B3 path).
//
// The return order carries:
//   - one negative line for what came back: its share of the original line's
//     net, tax and cost (returnMoney.ts computeReturnValue);
//   - one positive line for the restocking fee, when there is one, which the
//     journal books to POS_TRANSACTIONS/"Restocking Fee";
//   - an invoice dated the return day, but only when the original order was
//     invoiced: a sale that was recognised is reversed the same way. An
//     original never invoiced was never recognised, so its refund comes out
//     of the deposit liability with nothing to reverse.
//
// Its total is what the customer is owed (negative). Refunds on it bring it to
// zero; the customer's AR ledger moves with it.
//
// Idempotent: a second call returns the booking already made, and refuses a
// different fee, because the fee is part of what was booked.

import type { Prisma } from "@prisma/client";
import { appendEntry } from "@/lib/customerLedger";
import { POS_TRANSACTIONS_SECTION, RESTOCKING_FEE_MAPPING_LABEL } from "@/lib/glMapping";
import { roundMoney as round2 } from "@/lib/money";
import { toQty } from "@/lib/inventory/quantity";
import {
  computeReturnRefundable,
  computeReturnValue,
  resolveRestockingFee,
  ReturnMoneyError,
  type BookedFromLine,
  type RestockingFeeInput,
  type ReturnValue,
} from "./returnMoney";

type Tx = Prisma.TransactionClient;

/** Advisory-lock key space for a return's money; see STOCK_LOCK_SPACE in inventory/ledger.ts. */
const RETURN_LOCK_SPACE = 5_461_071;

export async function lockReturn(tx: Tx, returnId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RETURN_LOCK_SPACE}::int, ${returnId}::int)`;
}

export interface BookedReturn {
  returnOrderId: number;
  value: ReturnValue;
  fee: number;
  /** What the customer is owed: value incl. tax, less the fee. */
  total: number;
}

const n = (d: Prisma.Decimal | number | null | undefined) => Number(d ?? 0);

/** The return's booking, from the lines on its return order. */
async function existingBooking(
  tx: Tx,
  returnOrderId: number,
  feeLineId: number | null,
  quantity: number,
): Promise<BookedReturn> {
  const lines = await tx.orderLineItem.findMany({
    where: { salesOrderId: returnOrderId },
    select: { id: true, netPrice: true, vatAmount: true, cost: true },
  });
  const goods = lines.filter((l) => l.id !== feeLineId);
  const value: ReturnValue = {
    quantity,
    net: round2(-goods.reduce((s, l) => s + n(l.netPrice), 0)),
    tax: round2(-goods.reduce((s, l) => s + n(l.vatAmount), 0)),
    cost: round2(-goods.reduce((s, l) => s + n(l.cost), 0)),
  };
  const fee = round2(n(lines.find((l) => l.id === feeLineId)?.netPrice));
  return { returnOrderId, value, fee, total: round2(value.net + value.tax - fee) };
}

/** What other returns already booked out of the same original line. */
async function bookedFromLine(
  tx: Tx,
  lineItemId: number,
  returnId: number,
): Promise<BookedFromLine> {
  const others = await tx.return.findMany({
    where: { lineItemId, id: { not: returnId }, returnOrderId: { not: null } },
    select: {
      quantity: true,
      restockingFeeLineItemId: true,
      returnOrder: {
        select: {
          lineItems: { select: { id: true, netPrice: true, vatAmount: true, cost: true } },
        },
      },
    },
  });
  const booked: BookedFromLine = { quantity: 0, net: 0, tax: 0, cost: 0 };
  for (const o of others) {
    booked.quantity += toQty(o.quantity);
    for (const l of o.returnOrder?.lineItems ?? []) {
      if (l.id === o.restockingFeeLineItemId) continue;
      booked.net = round2(booked.net - n(l.netPrice));
      booked.tax = round2(booked.tax - n(l.vatAmount));
      booked.cost = round2(booked.cost - n(l.cost));
    }
  }
  return booked;
}

async function assertFeeAccountMapped(tx: Tx): Promise<void> {
  const mapping = await tx.systemGLMapping.findUnique({
    where: {
      section_label: { section: POS_TRANSACTIONS_SECTION, label: RESTOCKING_FEE_MAPPING_LABEL },
    },
    select: { glAccountId: true },
  });
  if (!mapping?.glAccountId) {
    throw new ReturnMoneyError(
      `A restocking fee needs an income account: map "${RESTOCKING_FEE_MAPPING_LABEL}" under POS Transactions in Admin › Setup › Accounting first.`,
    );
  }
}

/** Whether a nonzero fee can be booked now (the fee account is mapped). */
export async function feeAccountMapped(tx: Tx): Promise<boolean> {
  try {
    await assertFeeAccountMapped(tx);
    return true;
  } catch {
    return false;
  }
}

export async function bookReturn(
  tx: Tx,
  returnId: number,
  opts: { fee?: RestockingFeeInput; at?: Date; createdBy?: string | null } = {},
): Promise<BookedReturn> {
  await lockReturn(tx, returnId);
  const ret = await tx.return.findUniqueOrThrow({
    where: { id: returnId },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      quantity: true,
      customerId: true,
      lineItemId: true,
      returnOrderId: true,
      restockingFeeLineItemId: true,
      receivedLocationId: true,
      lineItem: {
        select: {
          netPrice: true,
          vatAmount: true,
          vatRate: true,
          cost: true,
          orderedQuantity: true,
          productId: true,
          productName: true,
          partNo: true,
          taxDistrictId: true,
        },
      },
      salesOrder: {
        select: {
          id: true,
          orderno: true,
          customerId: true,
          salesperson: true,
          salesPersonId: true,
          storeLocation: true,
          storeLocationId: true,
          taxDistrictId: true,
          taxExemptReasonId: true,
          invoices: { where: { status: { not: "VOID" } }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  const quantity = toQty(ret.quantity);

  if (ret.returnOrderId != null) {
    const booked = await existingBooking(
      tx,
      ret.returnOrderId,
      ret.restockingFeeLineItemId,
      quantity,
    );
    if (opts.fee !== undefined) {
      const asked = resolveRestockingFee(booked.value.net, opts.fee);
      if (asked !== booked.fee) {
        throw new ReturnMoneyError(
          `The restocking fee was booked at $${booked.fee.toFixed(2)} with this return's first refund and cannot change.`,
        );
      }
    }
    return booked;
  }

  if (ret.status === "CANCELLED")
    throw new ReturnMoneyError("A cancelled return has no money to pay out.");
  if (!ret.lineItemId || !ret.lineItem) {
    throw new ReturnMoneyError(
      "This return names no order line, so Holt cannot tell what it is worth. Start the return from the line being returned.",
    );
  }

  const line = ret.lineItem;
  const value = computeReturnValue(
    {
      netPrice: n(line.netPrice),
      vatAmount: n(line.vatAmount),
      cost: n(line.cost),
      orderedQuantity: n(line.orderedQuantity),
    },
    quantity,
    await bookedFromLine(tx, ret.lineItemId, ret.id),
  );
  const fee = resolveRestockingFee(value.net, opts.fee);
  if (fee > 0) await assertFeeAccountMapped(tx);

  // Refunded in full before returns were booked (the old refund route wrote
  // its refunds against the original order): booking now would reverse the
  // sale a second time for money already given back.
  const earlier = await tx.payment.findMany({
    where: { returnId: ret.id, isRefund: true },
    select: { paymentAmount: true, status: true },
  });
  const paidBefore = computeReturnRefundable({
    value,
    fee,
    refunds: earlier.map((r) => ({ amount: n(r.paymentAmount), status: r.status })),
  });
  if (earlier.length > 0 && paidBefore.refundable <= 0) {
    throw new ReturnMoneyError("Nothing is left to refund on this return.");
  }

  const original = ret.salesOrder;
  const customerId = ret.customerId ?? original.customerId;
  const at = opts.at ?? new Date();
  const returnOrder = await tx.salesOrder.create({
    data: {
      orderno: ret.returnNumber,
      orderDate: at,
      status: "RETURNED",
      customerId,
      salesperson: original.salesperson,
      salesPersonId: original.salesPersonId,
      storeLocation: original.storeLocation,
      storeLocationId: ret.receivedLocationId ?? original.storeLocationId,
      taxDistrictId: original.taxDistrictId,
      taxExemptReasonId: original.taxExemptReasonId,
      orderNotes: `Return ${ret.returnNumber} of order ${original.orderno}`,
      createdBy: opts.createdBy ?? null,
    },
    select: { id: true },
  });
  await tx.orderLineItem.create({
    data: {
      salesOrderId: returnOrder.id,
      lineNumber: 1,
      productId: line.productId,
      productName: line.productName,
      partNo: line.partNo,
      orderedQuantity: quantity,
      netPrice: -value.net,
      vatAmount: -value.tax,
      vatRate: line.vatRate,
      cost: -value.cost,
      taxDistrictId: line.taxDistrictId,
    },
  });
  let feeLineId: number | null = null;
  if (fee > 0) {
    const feeLine = await tx.orderLineItem.create({
      data: {
        salesOrderId: returnOrder.id,
        lineNumber: 2,
        productName: "Restocking fee",
        orderedQuantity: 1,
        netPrice: fee,
        vatAmount: 0,
        cost: 0,
      },
      select: { id: true },
    });
    feeLineId = feeLine.id;
  }
  // Reversed the way it was recognised: only a sale that was invoiced.
  if (original.invoices.length > 0) {
    await tx.invoice.create({
      data: {
        invoiceNo: ret.returnNumber,
        invoiceDate: at,
        taxAmount: -value.tax,
        salesOrderId: returnOrder.id,
      },
    });
  }
  await tx.return.update({
    where: { id: ret.id },
    data: {
      returnOrderId: returnOrder.id,
      restockingFeeLineItemId: feeLineId,
      updatedBy: opts.createdBy ?? null,
    },
  });

  const total = round2(value.net + value.tax - fee);
  if (customerId != null && total !== 0) {
    await appendEntry(
      {
        customerId,
        type: "SALE",
        amount: -total,
        salesOrderId: returnOrder.id,
        reference: ret.returnNumber,
        notes: `Return of ${original.orderno}`,
        createdBy: opts.createdBy ?? undefined,
      },
      tx,
    );
  }
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: original.id,
      lineItemId: ret.lineItemId,
      changeType: "RETURN_BOOKED",
      newValue: `${ret.returnNumber}: $${total.toFixed(2)}${fee > 0 ? ` after a $${fee.toFixed(2)} restocking fee` : ""}`,
      changedBy: opts.createdBy ?? null,
    },
  });
  return { returnOrderId: returnOrder.id, value, fee, total };
}

/**
 * Why order `salesOrderId` cannot be edited, or null. A native return's own
 * order is what its refunds and journal stand on; it changes only through
 * its return. Every order and line edit route asks (rule 42).
 */
export async function returnOrderEditProblem(
  db: Pick<Tx, "return">,
  salesOrderId: number,
): Promise<string | null> {
  const ret = await db.return.findUnique({
    where: { returnOrderId: salesOrderId },
    select: { returnNumber: true },
  });
  return ret
    ? `This is return ${ret.returnNumber}'s own order: it changes only through the return.`
    : null;
}
