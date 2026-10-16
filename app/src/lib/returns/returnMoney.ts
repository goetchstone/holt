// /app/src/lib/returns/returnMoney.ts
//
// The money rules of a native return, pure so they are tested without a
// database (ledger plan PR 2b). The database-facing halves are bookReturn.ts
// (the return's own RETURNED order) and refundReturn.ts (paying it out).
//
//   - What came back is worth its share of the original line: net, tax and
//     cost prorated by quantity. A return that completes the line takes the
//     remainder, so splitting a line across returns never loses a cent.
//   - A restocking fee is kept from that value: a percent of the goods' net
//     or an amount, typed by staff per return, 0 unless they say otherwise.
//     It is never more than the goods' net and never negative.
//   - What can still be refunded is the value, less the fee, less every
//     refund that is COMPLETED or still PENDING with the processor. A FAILED
//     or VOIDED refund paid nothing out, so it does not count. What the
//     return pays toward the original order's open balance is itself a
//     refund to store credit spent on that order (refundReturn.ts), so it is
//     counted the same way.

import { roundMoney as round2 } from "@/lib/money";
import { roundQty, qtyEquals } from "@/lib/inventory/quantity";

export class ReturnMoneyError extends Error {}

export interface LineForValue {
  netPrice: number;
  vatAmount: number;
  cost: number;
  orderedQuantity: number;
}

export interface ReturnValue {
  quantity: number;
  net: number;
  tax: number;
  cost: number;
}

/** Money already booked out of the same line by other returns. */
export interface BookedFromLine {
  quantity: number;
  net: number;
  tax: number;
  cost: number;
}

const NOTHING_BOOKED: BookedFromLine = { quantity: 0, net: 0, tax: 0, cost: 0 };

/**
 * What `quantity` of `line` is worth, given what other returns already took
 * from it. Refuses a quantity of nothing, or more than is left on the line.
 */
export function computeReturnValue(
  line: LineForValue,
  quantity: number,
  booked: BookedFromLine = NOTHING_BOOKED,
): ReturnValue {
  if (!(quantity > 0)) throw new ReturnMoneyError("A return must bring back more than nothing.");
  if (!(line.orderedQuantity > 0)) {
    throw new ReturnMoneyError("The order line has no quantity, so nothing on it can be returned.");
  }
  const left = roundQty(line.orderedQuantity - booked.quantity);
  if (quantity > left && !qtyEquals(quantity, left)) {
    throw new ReturnMoneyError(
      `Only ${left} of ${line.orderedQuantity} on this line can still be returned.`,
    );
  }
  if (qtyEquals(quantity, left)) {
    return {
      quantity,
      net: round2(line.netPrice - booked.net),
      tax: round2(line.vatAmount - booked.tax),
      cost: round2(line.cost - booked.cost),
    };
  }
  const share = quantity / line.orderedQuantity;
  return {
    quantity,
    net: round2(line.netPrice * share),
    tax: round2(line.vatAmount * share),
    cost: round2(line.cost * share),
  };
}

export type RestockingFeeInput = { percent: number } | { amount: number } | null | undefined;

/** The fee kept from `goodsNet`: 0 by default, clamped to [0, goodsNet]. */
export function resolveRestockingFee(goodsNet: number, fee: RestockingFeeInput): number {
  if (!fee) return 0;
  const raw = "percent" in fee ? (goodsNet * fee.percent) / 100 : fee.amount;
  if (!Number.isFinite(raw)) throw new ReturnMoneyError("The restocking fee must be a number.");
  if (raw < 0) throw new ReturnMoneyError("A restocking fee cannot be negative.");
  return round2(Math.min(raw, Math.max(goodsNet, 0)));
}

/** A refund already recorded against the return. */
export interface RecordedRefund {
  amount: number;
  status: string | null;
}

/** Statuses of a refund row that paid out, or may still pay out. */
const COUNTED_REFUND_STATUSES = new Set(["COMPLETED", "PENDING"]);

export function refundCounts(status: string | null): boolean {
  // A refund row written before statuses existed paid out.
  return status == null || COUNTED_REFUND_STATUSES.has(status);
}

/** The return's value incl. tax, less the fee, less what is already paid out. */
export function computeReturnRefundable(args: {
  value: ReturnValue;
  fee: number;
  refunds: RecordedRefund[];
}): { total: number; refunded: number; refundable: number } {
  const total = round2(args.value.net + args.value.tax - args.fee);
  const refunded = round2(
    args.refunds
      .filter((r) => refundCounts(r.status))
      .reduce((sum, r) => sum + Math.abs(r.amount), 0),
  );
  return { total, refunded, refundable: Math.max(0, round2(total - refunded)) };
}
