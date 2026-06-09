// /app/src/lib/paymentService.ts
import { prisma } from "@/lib/prisma";
import { getStripe } from "@/lib/stripe";
import { syncServiceAppointments } from "@/lib/serviceDispatchService";
import { isMarjanRug, toMarjanBarcode, toMarjanCustomerNumber } from "@/lib/consignment";
import { appendEntry } from "@/lib/customerLedger";
import { logError } from "@/lib/logger";
import type { Payment } from "@prisma/client";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// Accept Prisma Decimal, string, or number -- Number() handles all three
type Numeric = number | string | { toNumber(): number };

interface LineItemForBalance {
  netPrice: Numeric;
  orderedQuantity: Numeric;
  vatAmount?: Numeric | null;
}

interface PaymentForBalance {
  paymentAmount: Numeric;
  status?: string | null;
  isRefund: boolean;
}

// the POS rounding errors create micro-balances ($0.01, $0.02).
// Balances at or below this threshold are treated as paid in full.
const MICRO_BALANCE_THRESHOLD = 1.0;

// Pure computation -- no database access. Exported for testing.
//
// REWRITE CHAIN NOTE: when a customer balance query spans a rewrite
// chain (base SO-12345 + accounting return SR-12345 + rewrite SO-12345 - A),
// all three orders stay active. Balance math over the chain works because the
// payments import runner SKIPS the phantom "Gift Card" transfer that the POS
// attaches to the rewrite (it represents a credit-note application of the
// base's deposit, not a real second payment). With the phantom skipped, summing
// the chain yields: base_total - card_deposit - return_total + rewrite_total
// = rewrite_total - card_deposit. See docs/domains/POS-import.md
// "Rewrites -- what the payments really mean" and CLAUDE.md Key Gotchas.
export function computeBalance(
  lineItems: LineItemForBalance[],
  payments: PaymentForBalance[],
): { totalDue: number; totalPaid: number; balanceDue: number } {
  const excludedStatuses = new Set(["VOIDED", "FAILED"]);

  // INVARIANT: OrderLineItem.netPrice stores the LINE TOTAL (unit price × qty),
  // never the unit price. Both the POS imports and POS creation follow this model.
  // Do NOT multiply by orderedQuantity here — that was a bug that inflated totals
  // for multi-qty line items (e.g. 195 sq ft of rug pad). Fixed 2026-04-17.
  const totalDue = round2(
    lineItems.reduce((sum, li) => {
      const lineTotal = Number(li.netPrice);
      const vat = Number(li.vatAmount ?? 0);
      return sum + lineTotal + vat;
    }, 0),
  );

  const totalPaid = round2(
    payments.reduce((sum, p) => {
      if (p.status && excludedStatuses.has(p.status)) return sum;
      const amt = Number(p.paymentAmount);
      return sum + (p.isRefund ? -Math.abs(amt) : amt);
    }, 0),
  );

  const rawBalance = round2(totalDue - totalPaid);
  // Snap micro-balances to zero — the POS rounding artifacts
  const balanceDue = Math.abs(rawBalance) <= MICRO_BALANCE_THRESHOLD ? 0 : rawBalance;

  return { totalDue, totalPaid, balanceDue };
}

// Pure computation for refundable amount
export function computeRefundable(originalAmount: number, previousRefundAmounts: number[]): number {
  const totalRefunded = previousRefundAmounts.reduce((sum, a) => sum + Math.abs(a), 0);
  return round2(originalAmount - totalRefunded);
}

interface RecordPaymentInput {
  method: string;
  amount: number;
  registerId?: number;
  tillId?: number;
  staffMemberId?: number;
  customerId?: number;
  processorType?: string;
  processorTxnId?: string;
  processorData?: any;
  cardLast4?: string;
  cardBrand?: string;
  checkNumber?: string;
  giftCardId?: number;
  createdBy?: string;
}

interface RefundInput {
  amount: number;
  method?: string;
  reason?: string;
  registerId?: number;
  tillId?: number;
  staffMemberId?: number;
  customerId?: number;
  createdBy?: string;
}

interface OrderBalance {
  totalDue: number;
  totalPaid: number;
  balanceDue: number;
  payments: {
    id: number;
    date: Date;
    type: string;
    method: string | null;
    amount: number;
    status: string | null;
    isRefund: boolean;
  }[];
}

const METHOD_DISPLAY: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  GIFT_CARD: "Gift Card",
  STORE_CREDIT: "Store Credit",
  WIRE: "Wire",
  ACH: "ACH",
  FINANCE: "Finance",
  OTHER: "Other",
};

export async function calculateOrderBalance(orderId: number): Promise<OrderBalance> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lineItems: {
        select: { netPrice: true, orderedQuantity: true, vatAmount: true },
      },
      payments: {
        select: {
          id: true,
          paymentDate: true,
          paymentType: true,
          method: true,
          paymentAmount: true,
          status: true,
          isRefund: true,
        },
        orderBy: { paymentDate: "asc" },
      },
    },
  });

  const { totalDue, totalPaid, balanceDue } = computeBalance(order.lineItems, order.payments);

  return {
    totalDue,
    totalPaid,
    balanceDue,
    payments: order.payments.map((p) => ({
      id: p.id,
      date: p.paymentDate,
      type: p.paymentType,
      method: p.method,
      amount: Number(p.paymentAmount),
      status: p.status,
      isRefund: p.isRefund,
    })),
  };
}

export async function recordPayment(orderId: number, input: RecordPaymentInput): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new Error("Payment amount must be positive");
  }

  return prisma.$transaction(async (tx) => {
    // Hydrate orderno alongside the existence check — saves a round trip
    // for the ledger reference field below.
    const order = await tx.salesOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, orderno: true, customerId: true },
    });

    if (input.tillId) {
      const till = await tx.till.findUniqueOrThrow({ where: { id: input.tillId } });
      if (till.status !== "OPEN") {
        throw new Error(`Till ${input.tillId} is not open (status: ${till.status})`);
      }
    }

    const paymentType = METHOD_DISPLAY[input.method] ?? input.method;

    if (input.method === "GIFT_CARD") {
      if (!input.giftCardId) {
        throw new Error("giftCardId is required for gift card payments");
      }
      const card = await tx.giftCard.findUniqueOrThrow({
        where: { id: input.giftCardId },
      });
      const balance = Number(card.currentBalance);
      if (balance < rounded) {
        throw new Error(
          `Insufficient gift card balance: available $${balance.toFixed(2)}, requested $${rounded.toFixed(2)}`,
        );
      }
      const balanceBefore = balance;
      const balanceAfter = round2(balanceBefore - rounded);

      await tx.giftCardTransaction.create({
        data: {
          giftCardId: input.giftCardId,
          transactionType: "REDEMPTION",
          amount: -rounded,
          balanceBefore,
          balanceAfter,
          createdBy: input.createdBy,
        },
      });
      await tx.giftCard.update({
        where: { id: input.giftCardId },
        data: { currentBalance: balanceAfter },
      });
    }

    if (input.method === "STORE_CREDIT") {
      if (!input.customerId) {
        throw new Error("customerId is required for store credit payments");
      }
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: input.customerId },
        select: { creditBalance: true },
      });
      const balanceBefore = Number(customer.creditBalance);
      if (balanceBefore < rounded) {
        throw new Error(
          `Insufficient store credit: available $${balanceBefore.toFixed(2)}, requested $${rounded.toFixed(2)}`,
        );
      }
      const balanceAfter = round2(balanceBefore - rounded);

      await tx.customerCreditTransaction.create({
        data: {
          customerId: input.customerId,
          type: "USAGE",
          amount: -rounded,
          balanceBefore,
          balanceAfter,
          salesOrderId: orderId,
          createdBy: input.createdBy,
        },
      });
      await tx.customer.update({
        where: { id: input.customerId },
        data: { creditBalance: balanceAfter },
      });
    }

    const payment = await tx.payment.create({
      data: {
        salesOrderId: orderId,
        paymentDate: new Date(),
        paymentType,
        paymentAmount: rounded,
        status: "COMPLETED",
        method: input.method as any,
        registerId: input.registerId,
        tillId: input.tillId,
        staffMemberId: input.staffMemberId,
        customerId: input.customerId,
        processorType: input.processorType,
        processorTxnId: input.processorTxnId,
        processorData: input.processorData ?? undefined,
        cardLast4: input.cardLast4,
        cardBrand: input.cardBrand,
        checkNumber: input.checkNumber,
        giftCardId: input.giftCardId,
        createdBy: input.createdBy,
      },
    });

    // Phase 0.5.4 (2026-05-12) — append the AR-ledger entry inside the
    // SAME transaction so Customer.openArBalance and the Payment row
    // commit atomically. Extracted to keep recordPayment under the cog-
    // complexity gate; the helper handles customerId resolution + the
    // appendEntry call + error surfacing.
    await appendPaymentLedger(tx, {
      customerId: input.customerId ?? order.customerId ?? null,
      type: "PAYMENT",
      amount: -rounded,
      salesOrderId: orderId,
      paymentId: payment.id,
      reference: order.orderno || `order-${orderId}`,
      createdBy: input.createdBy,
    });

    return payment;
  });
}

/**
 * Phase 0.5.4 — single point that calls `appendEntry` from the payment
 * flow. Skips when there's no customer to ledger against (true walk-in
 * cash sales on unlinked orders). Surfaces any underlying ledger error
 * with structured logging before rethrowing so the caller's transaction
 * rolls back atomically — silent skip would re-introduce the drift this
 * wiring was added to prevent.
 */
async function appendPaymentLedger(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: {
    customerId: number | null;
    type: "PAYMENT" | "REFUND_ISSUED";
    amount: number;
    salesOrderId: number | undefined;
    paymentId: number;
    reference: string;
    notes?: string;
    createdBy?: string | null;
  },
): Promise<void> {
  if (input.customerId === null) return; // walk-in; nothing to ledger
  try {
    await appendEntry(
      {
        customerId: input.customerId,
        type: input.type,
        amount: input.amount,
        salesOrderId: input.salesOrderId,
        paymentId: input.paymentId,
        reference: input.reference,
        notes: input.notes,
        createdBy: input.createdBy ?? undefined,
      },
      tx,
    );
  } catch (err) {
    logError(`appendEntry failed during ${input.type}`, err);
    throw err;
  }
}

/**
 * Create a PENDING payment with NO ledger entry. For processor flows (Stripe
 * checkout) where the money isn't confirmed until a webhook fires — the AR-ledger
 * entry is posted later by completePayment(), so an abandoned checkout never
 * leaves a phantom payment in the books. (#137)
 */
export async function recordPendingPayment(
  orderId: number,
  input: {
    method: string;
    amount: number;
    processorType?: string;
    processorTxnId?: string;
    customerId?: number | null;
    createdBy?: string | null;
  },
): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new Error("Payment amount must be positive");
  }
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { customerId: true },
  });
  return prisma.payment.create({
    data: {
      salesOrderId: orderId,
      paymentDate: new Date(),
      paymentType: (METHOD_DISPLAY as Record<string, string>)[input.method] ?? input.method,
      paymentAmount: rounded,
      status: "PENDING",
      method: input.method as any,
      processorType: input.processorType,
      processorTxnId: input.processorTxnId,
      customerId: input.customerId ?? order.customerId,
      createdBy: input.createdBy ?? undefined,
    },
  });
}

/**
 * Mark a PENDING payment COMPLETED and post its AR-ledger entry atomically —
 * called when a processor webhook confirms the charge. Idempotent: a re-fired
 * webhook on an already-COMPLETED payment is a no-op, so the ledger entry is
 * never double-posted. (#137)
 */
export async function completePayment(
  paymentId: number,
  extraData?: {
    processorData?: Record<string, unknown>;
    cardLast4?: string;
    cardBrand?: string;
  },
): Promise<Payment> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status === "COMPLETED") return payment;

    const order = payment.salesOrderId
      ? await tx.salesOrder.findUnique({
          where: { id: payment.salesOrderId },
          select: { orderno: true, customerId: true },
        })
      : null;

    const updated = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "COMPLETED",
        processorData: (extraData?.processorData as object) ?? undefined,
        cardLast4: extraData?.cardLast4,
        cardBrand: extraData?.cardBrand,
      },
    });

    await appendPaymentLedger(tx, {
      customerId: payment.customerId ?? order?.customerId ?? null,
      type: "PAYMENT",
      amount: -round2(Number(payment.paymentAmount)),
      salesOrderId: payment.salesOrderId ?? undefined,
      paymentId: payment.id,
      reference: order?.orderno || `order-${payment.salesOrderId}`,
      createdBy: payment.createdBy ?? undefined,
    });

    return updated;
  });
}

export async function processRefund(paymentId: number, input: RefundInput): Promise<Payment> {
  const rounded = round2(input.amount);
  if (rounded <= 0) {
    throw new Error("Refund amount must be positive");
  }

  return prisma.$transaction(async (tx) => {
    const original = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refundedPayments: true },
    });

    if (original.status !== "COMPLETED") {
      throw new Error(
        `Cannot refund payment ${paymentId}: status is ${original.status}, expected COMPLETED`,
      );
    }

    const originalAmount = Number(original.paymentAmount);
    const previousRefunds = original.refundedPayments.reduce(
      (sum, r) => sum + Math.abs(Number(r.paymentAmount)),
      0,
    );
    const refundable = round2(originalAmount - previousRefunds);

    if (rounded > refundable) {
      throw new Error(
        `Refund amount $${rounded.toFixed(2)} exceeds refundable balance $${refundable.toFixed(2)}`,
      );
    }

    // Issue refund through Stripe if original payment was processed via Stripe
    let stripeRefundId: string | null = null;
    if (original.processorType === "STRIPE" && original.processorTxnId) {
      try {
        const stripe = await getStripe();
        // The processorTxnId is the checkout session ID; retrieve the payment intent
        const session = await stripe.checkout.sessions.retrieve(original.processorTxnId);
        const paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : null;

        if (paymentIntentId) {
          const stripeRefund = await stripe.refunds.create({
            payment_intent: paymentIntentId,
            amount: Math.round(rounded * 100), // Stripe uses cents
            reason: "requested_by_customer",
          });
          stripeRefundId = stripeRefund.id;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Stripe refund failed";
        throw new Error(`Stripe refund failed: ${msg}`);
      }
    }

    const refundMethod = input.method ?? original.method;
    const paymentType = refundMethod
      ? (METHOD_DISPLAY[refundMethod] ?? refundMethod)
      : original.paymentType;

    const refundPayment = await tx.payment.create({
      data: {
        salesOrderId: original.salesOrderId,
        paymentDate: new Date(),
        paymentType,
        paymentAmount: rounded,
        status: "COMPLETED",
        method: (refundMethod as any) ?? undefined,
        isRefund: true,
        originalPaymentId: paymentId,
        refundReason: input.reason,
        registerId: input.registerId,
        tillId: input.tillId,
        staffMemberId: input.staffMemberId,
        customerId: original.customerId,
        processorType: stripeRefundId ? "STRIPE" : original.processorType,
        processorTxnId: stripeRefundId || undefined,
        createdBy: input.createdBy,
      },
    });

    // If fully refunded, mark the original
    const totalRefunded = round2(previousRefunds + rounded);
    if (totalRefunded >= originalAmount) {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "REFUNDED" },
      });
    }

    // Method-specific side effects
    const effectiveMethod = refundMethod ?? original.method;

    if (effectiveMethod === "STORE_CREDIT" && original.customerId) {
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: original.customerId },
        select: { creditBalance: true },
      });
      const balanceBefore = Number(customer.creditBalance);
      const balanceAfter = round2(balanceBefore + rounded);

      await tx.customerCreditTransaction.create({
        data: {
          customerId: original.customerId,
          type: "REFUND_CREDIT",
          amount: rounded,
          balanceBefore,
          balanceAfter,
          paymentId: refundPayment.id,
          salesOrderId: original.salesOrderId ?? undefined,
          notes: input.reason,
          createdBy: input.createdBy,
        },
      });
      await tx.customer.update({
        where: { id: original.customerId },
        data: { creditBalance: balanceAfter },
      });
    }

    if (effectiveMethod === "GIFT_CARD" && original.giftCardId) {
      const card = await tx.giftCard.findUniqueOrThrow({
        where: { id: original.giftCardId },
      });
      const balanceBefore = Number(card.currentBalance);
      const balanceAfter = round2(balanceBefore + rounded);

      await tx.giftCardTransaction.create({
        data: {
          giftCardId: original.giftCardId,
          transactionType: "RELOAD",
          amount: rounded,
          balanceBefore,
          balanceAfter,
          notes: input.reason,
          createdBy: input.createdBy,
        },
      });
      await tx.giftCard.update({
        where: { id: original.giftCardId },
        data: { currentBalance: balanceAfter },
      });
    }

    // Phase 0.5.4 (2026-05-12) — append REFUND_ISSUED entry inside the
    // same tx as the refund Payment row. REFUND_ISSUED is positive-signed
    // (we gave money back → customer balance owed goes UP, mirroring
    // computeBalance's "refunds SUBTRACT from totalPaid" rule). Order
    // lookup is conditional — original.salesOrderId can be null for
    // legacy unlinked payments.
    const orderForLedger =
      original.salesOrderId === null
        ? null
        : await tx.salesOrder.findUnique({
            where: { id: original.salesOrderId },
            select: { customerId: true, orderno: true },
          });
    await appendPaymentLedger(tx, {
      customerId: original.customerId ?? orderForLedger?.customerId ?? null,
      type: "REFUND_ISSUED",
      amount: rounded,
      salesOrderId: original.salesOrderId ?? undefined,
      paymentId: refundPayment.id,
      reference: orderForLedger?.orderno || `refund-${refundPayment.id}`,
      notes: input.reason,
      createdBy: input.createdBy,
    });

    return refundPayment;
  });
}

// Called after a payment is completed (from webhook, manual entry, or POS).
// Promotes QUOTE → ORDER and creates draft purchase orders for vendor items.
export async function onPaymentReceived(orderId: number): Promise<void> {
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lineItems: {
        include: {
          product: {
            select: { id: true, vendorId: true, productNumber: true, name: true, baseCost: true },
          },
        },
      },
    },
  });

  // Promote QUOTE → ORDER on first payment
  if (order.status === "QUOTE") {
    await prisma.salesOrder.update({
      where: { id: orderId },
      data: { status: "ORDER" },
    });

    // Create service appointments for any service line items
    await syncServiceAppointments(orderId);

    // Mark consignment items as SOLD when their rug sells
    await syncConsignmentSales(orderId, order.lineItems, order.orderDate ?? new Date());
  }

  // Create draft POs grouped by vendor for items that need ordering
  const vendorItems = new Map<
    number,
    { productId: number; partNo: string; name: string; qty: number; cost: number }[]
  >();

  for (const li of order.lineItems) {
    // Only create POs for special-order items (skip floor stock)
    if (li.source === "FLOOR") continue;
    if (!li.product?.vendorId) continue;
    const vendorId = li.product.vendorId;
    if (!vendorItems.has(vendorId)) vendorItems.set(vendorId, []);
    // Use the line item's configured cost if available, otherwise fall back to
    // the product's baseCost from the catalog (populated by the pricing import)
    const lineCost = Number(li.cost || 0);
    const productCost = Number(li.product.baseCost || 0);
    vendorItems.get(vendorId)!.push({
      productId: li.product.id,
      partNo: li.product.productNumber,
      name: li.product.name,
      qty: Number(li.orderedQuantity),
      cost: lineCost > 0 ? lineCost : productCost,
    });
  }

  // Only create POs if there are vendor items and none exist yet for this order
  if (vendorItems.size > 0) {
    const existingPOs = await prisma.purchaseOrder.findMany({
      where: { salesOrderId: orderId },
      select: { id: true },
    });

    if (existingPOs.length === 0) {
      const now = new Date();
      const yy = now.getFullYear().toString().slice(-2);
      const mm = (now.getMonth() + 1).toString().padStart(2, "0");
      const dd = now.getDate().toString().padStart(2, "0");

      for (const [vendorId, items] of vendorItems) {
        // Generate PO number
        const poPrefix = `PO-${yy}${mm}${dd}-`;
        const lastPO = await prisma.purchaseOrder.findFirst({
          where: { poNumber: { startsWith: poPrefix } },
          orderBy: { poNumber: "desc" },
          select: { poNumber: true },
        });
        let poSeq = 1;
        if (lastPO) {
          const lastSeq = Number.parseInt(lastPO.poNumber.replace(poPrefix, ""), 10);
          if (!Number.isNaN(lastSeq)) poSeq = lastSeq + 1;
        }
        const poNumber = `${poPrefix}${poSeq.toString().padStart(3, "0")}`;

        await prisma.purchaseOrder.create({
          data: {
            poNumber,
            vendorId,
            salesOrderId: orderId,
            status: "DRAFT",
            orderDate: now,
            createdBy: order.salesperson || null,
            lineItems: {
              create: items.map((item) => ({
                productId: item.productId,
                partNo: item.partNo,
                productName: item.name,
                orderedQuantity: item.qty,
                unitCost: item.cost,
              })),
            },
          },
        });
      }
    }
  }
}

// When a return is processed, revert any consignment rugs back to ON_FLOOR.
// Mirrors syncConsignmentSales in reverse — called from the sales import runner
// when a RETURNED order is encountered.
// If the rug was already PAID to the vendor, it goes back ON_FLOOR but with
// creditOwed=true so the credit can be applied to the next vendor payment.
//
// Matches by barcode first (Marjan internal format: M1812-91), then falls back
// to customerNumber (the POS format: MAR-9381-25 → customerNumber 9381-25)
// because the two systems use different numbering.
export async function syncConsignmentReturns(
  lineItems: { productNumber?: string | null }[],
): Promise<void> {
  for (const li of lineItems) {
    const pn = li.productNumber;
    if (!isMarjanRug(pn)) continue;

    // Try barcode match first, then customerNumber
    const barcode = toMarjanBarcode(pn!);
    let item = await prisma.consignmentItem.findUnique({ where: { barcode } });
    if (!item) {
      const cn = toMarjanCustomerNumber(pn!);
      if (cn) {
        item = await prisma.consignmentItem.findFirst({ where: { customerNumber: cn } });
      }
    }
    if (!item) continue;

    if (item.status === "SOLD") {
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "ON_FLOOR",
          salesOrderId: null,
          saleDate: null,
          saleTransactionId: null,
          saleCustomerName: null,
        },
      });
    } else if (item.status === "PAID") {
      // Vendor already paid — revert to ON_FLOOR but flag as credit owed.
      // Preserve consignmentPaymentBatchId for audit trail.
      await prisma.consignmentItem.update({
        where: { id: item.id },
        data: {
          status: "ON_FLOOR",
          creditOwed: true,
          salesOrderId: null,
          saleDate: null,
          saleTransactionId: null,
          saleCustomerName: null,
        },
      });
    }
  }
}

// When a sale is confirmed, check if any line items are consignment rugs
// and mark the corresponding ConsignmentItem as SOLD with the SalesOrder link.
async function syncConsignmentSales(
  orderId: number,
  lineItems: { product: { id: number; productNumber: string } | null }[],
  orderDate: Date,
): Promise<void> {
  for (const li of lineItems) {
    if (!li.product) continue;
    const pn = li.product.productNumber;
    if (!isMarjanRug(pn)) continue;
    const barcode = toMarjanBarcode(pn);

    const item = await prisma.consignmentItem.findUnique({ where: { barcode } });
    if (!item) continue;

    // PAID item appearing on a new sale with creditOwed: the re-sale cancels
    // the credit (exchange or return-and-rebuy). Clear creditOwed but keep PAID.
    if (item.status === "PAID" && item.creditOwed) {
      await prisma.consignmentItem.update({
        where: { barcode },
        data: { creditOwed: false },
      });
      continue;
    }

    // Skip items already in a terminal sale state
    if (item.status === "SOLD" || item.status === "PAID") continue;

    // When a previously-returned item re-sells, clear creditOwed
    await prisma.consignmentItem.update({
      where: { barcode },
      data: {
        status: "SOLD",
        salesOrderId: orderId,
        saleDate: orderDate,
        ...(item.creditOwed ? { creditOwed: false } : {}),
      },
    });
  }
}

export async function calculateTillExpected(tillId: number): Promise<{
  cash: number;
  card: number;
  check: number;
  giftCard: number;
  storeCredit: number;
  other: number;
  total: number;
  expectedCash: number;
}> {
  const till = await prisma.till.findUniqueOrThrow({
    where: { id: tillId },
    select: { openingCash: true },
  });

  // Use OR: { status: null } because Postgres treats NULL != 'VOIDED' as unknown
  // and excludes all 44K NULL-status payments (pre-status-field data).
  const payments = await prisma.payment.findMany({
    where: {
      tillId,
      OR: [{ status: null }, { status: { not: "VOIDED" } }],
    },
    select: { method: true, paymentAmount: true, isRefund: true },
  });

  const buckets: Record<string, number> = {
    CASH: 0,
    CARD: 0,
    CHECK: 0,
    GIFT_CARD: 0,
    STORE_CREDIT: 0,
  };

  for (const p of payments) {
    const key = p.method ?? "OTHER";
    const amt = Number(p.paymentAmount);
    const signed = p.isRefund ? -Math.abs(amt) : amt;
    if (key in buckets) {
      buckets[key] = round2(buckets[key] + signed);
    } else {
      buckets["OTHER"] = round2((buckets["OTHER"] ?? 0) + signed);
    }
  }

  // Cash in the drawer includes the opening float
  const cashNet = round2(Number(till.openingCash) + buckets["CASH"]);

  return {
    cash: cashNet,
    card: buckets["CARD"],
    check: buckets["CHECK"],
    giftCard: buckets["GIFT_CARD"],
    storeCredit: buckets["STORE_CREDIT"],
    other: buckets["OTHER"] ?? 0,
    total: round2(
      cashNet +
        buckets["CARD"] +
        buckets["CHECK"] +
        buckets["GIFT_CARD"] +
        buckets["STORE_CREDIT"] +
        (buckets["OTHER"] ?? 0),
    ),
    expectedCash: cashNet,
  };
}
