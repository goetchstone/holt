// app/prisma/seed/demo/salesOrders.ts
//
// The heart of the seed: SalesOrders + OrderLineItems + Payments, grouped
// into real till sessions (open -> transact -> close with counts and
// variance) per (register, business day). This is what makes
// generateSalesJournal() have something real to chew on, and what proves
// the till-variance escalation discipline (docs/domains/pos.md) end to
// end.
//
// Design notes (see docs/domains/seed-data.md for the full writeup):
//
// - Invoiced vs deposit-only: ~70% of orders get an Invoice row at time of
//   sale (immediate/floor sales) so `generateSalesJournal` recognizes real
//   Sales/COGS/Inventory/Tax that day. The other ~30% stay un-invoiced
//   (special-order deposits awaiting delivery) and book purely to "Pmt On
//   Acct" — matching `docs/domains/accounting.md`'s own worked sample,
//   where deposits dwarf same-day revenue. InvoiceLineItem rows are
//   intentionally NOT created (generateSalesJournal only checks
//   `invoices.length > 0`, never their contents) — skipping them lets line
//   items batch through `createMany` instead of one round trip per line.
// - Refunds are modeled as a same-day mirrored NEGATIVE OrderLineItem
//   (return-shaped, per the B3 "sales-in-reverse" mechanism in
//   lib/journalEntry.ts) plus a second Payment row (isRefund: true,
//   positive paymentAmount — `processRefund`'s real sign convention) on
//   the SAME order. Only invoiced orders get refunds: an un-invoiced
//   order's line items never reach buildJournalLines, so a mirrored line
//   there would be inert. This is what keeps the generated journal
//   genuinely balanced on refund days instead of leaning on the
//   Over/Short line to paper over an un-reversed sale.
// - Gift card / store credit tenders create their own real liability
//   trail (GiftCard + GiftCardTransaction, CustomerCreditTransaction +
//   Customer.creditBalance) — the same rows paymentService.ts's
//   recordPayment()/processRefund() would write, just constructed
//   directly for bulk-seeding throughput.

import type { PrismaClient } from "@prisma/client";
import { applyRegisterVarianceBlock, classifyTillVariance } from "@/lib/tillVariance";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import type { Rng } from "./rng";
import { randFloat, randInt, round2, subRng } from "./rng";
import { breakdownCash, TILL_OPENING_FLOAT } from "./tillCash";
import { buildOrderPlans, type OrderPlan, type PaymentMethodTender } from "./orderPlan";
import type { CatalogProduct } from "./catalog";
import type { SeededCustomer } from "./customers";
import type { SeededStaffMember, StaffSetup } from "./staff";

const SEED_ACTOR = "seed:demo";

export interface StoreForOrders {
  id: number;
  registerIds: number[];
}

export interface SalesOrdersResult {
  ordersCreated: number;
  invoicesCreated: number;
  paymentsCreated: number;
  refundPaymentsCreated: number;
  giftCardsCreated: number;
  tillsClosed: number;
  tillsOpen: number;
  methodCounts: Record<string, number>;
  refundCount: number;
  forcedVariance: { note: number; manager: number; escalation: number };
  blockedRegisterId: number | null;
  openTillId: number;
}

interface PaymentRecord {
  method: PaymentMethodTender;
  amount: number;
  isRefund: boolean;
  time: Date;
}

function dateKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Same calendar day (UTC), 30min-4h later, clamped to 20:00 so it never
 * spills into the next day's till session. */
function sameDayLaterTime(rng: Rng, date: Date): Date {
  const addMinutes = randInt(rng, 30, 240);
  const t = new Date(date.getTime() + addMinutes * 60_000);
  const dayEnd = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 20, 0, 0),
  );
  return t.getTime() > dayEnd.getTime() ? dayEnd : t;
}

export async function seedSalesOrdersAndTills(
  prisma: PrismaClient,
  rng: Rng,
  window: { start: Date; end: Date },
  orderCount: number,
  stores: readonly StoreForOrders[],
  staff: StaffSetup,
  customers: readonly SeededCustomer[],
  products: readonly CatalogProduct[],
  taxDistrictId: number,
): Promise<SalesOrdersResult> {
  const productById = new Map(products.map((p) => [p.id, p]));
  const registerToStore = new Map<number, number>();
  for (const s of stores) for (const r of s.registerIds) registerToStore.set(r, s.id);

  const plans = buildOrderPlans(
    rng,
    window,
    orderCount,
    stores,
    staff,
    customers,
    products,
    100_000,
  );

  // Group by (registerId, calendar day) -- one till session per group.
  const groups = new Map<string, OrderPlan[]>();
  for (const plan of plans) {
    const key = `${plan.registerId}::${dateKeyUTC(plan.date)}`;
    const arr = groups.get(key);
    if (arr) arr.push(plan);
    else groups.set(key, [plan]);
  }
  const groupEntries = [...groups.entries()].sort(
    (a, b) => a[1][0].date.getTime() - b[1][0].date.getTime(),
  );
  const n = groupEntries.length;
  if (n === 0) throw new Error("seedSalesOrdersAndTills: no order groups were generated");

  // Forced till-variance demonstrations (docs/domains/pos.md thresholds:
  // NOTE > $5, MANAGER > $20, ESCALATION > $100). Spread through the
  // timeline; ESCALATION lands near the very end (second-to-last session)
  // so the resulting register block is still "in effect" as of the seed's
  // reference date, and the LAST session of all is left OPEN — a
  // still-in-progress till, as if "today" hasn't closed out yet.
  const noteIdx = Math.max(0, Math.min(n - 4, Math.floor(n * 0.35)));
  const managerIdx = Math.max(noteIdx + 1, Math.min(n - 3, Math.floor(n * 0.65)));
  const escalationIdx = Math.max(managerIdx + 1, n - 2);
  const openIdx = n - 1;

  const varianceRng = subRng(rng, "till-variance");
  const cashFlowRng = subRng(rng, "gift-card-store-credit");

  const result: SalesOrdersResult = {
    ordersCreated: 0,
    invoicesCreated: 0,
    paymentsCreated: 0,
    refundPaymentsCreated: 0,
    giftCardsCreated: 0,
    tillsClosed: 0,
    tillsOpen: 0,
    methodCounts: {},
    refundCount: 0,
    forcedVariance: { note: 0, manager: 0, escalation: 0 },
    blockedRegisterId: null,
    openTillId: 0,
  };

  const customerCreditBalance = new Map<number, number>();
  let giftCardSeq = 700_001;

  function resolveTillStaff(storeId: number): SeededStaffMember {
    const local = staff.registerStaff.find((s) => s.homeStoreId === storeId);
    if (local) return local;
    if (staff.registerStaff.length > 0) return staff.registerStaff[0];
    const manager = staff.managers.find((m) => m.homeStoreId === storeId);
    return manager ?? staff.managers[0] ?? staff.superAdmin;
  }

  async function ensureStoreCredit(customerId: number, needed: number, asOf: Date): Promise<void> {
    const current = customerCreditBalance.get(customerId) ?? 0;
    if (current >= needed) return;
    const grant = Math.max(25, Math.ceil((needed - current) / 25) * 25 + 25);
    const balanceBefore = current;
    const balanceAfter = round2(balanceBefore + grant);
    const grantedAt = new Date(asOf.getTime() - randInt(cashFlowRng, 14, 90) * 86_400_000);
    await prisma.customerCreditTransaction.create({
      data: {
        customerId,
        type: "ADJUSTMENT",
        amount: grant,
        balanceBefore,
        balanceAfter,
        reference: "Opening store-credit balance",
        notes: "Synthetic seed data — store-credit balance established for demo purposes.",
        createdBy: SEED_ACTOR,
        created: grantedAt,
      },
    });
    customerCreditBalance.set(customerId, balanceAfter);
    await prisma.customer.update({
      where: { id: customerId },
      data: { creditBalance: balanceAfter },
    });
  }

  for (let gi = 0; gi < groupEntries.length; gi++) {
    const [, orders] = groupEntries[gi];
    const registerId = orders[0].registerId;
    const storeId = registerToStore.get(registerId)!;
    const openedBy = resolveTillStaff(storeId);
    const firstOrderTime = orders[0].date;

    const till = await prisma.till.create({
      data: {
        registerId,
        status: "OPEN",
        openedAt: new Date(firstOrderTime.getTime() - 20 * 60_000),
        openedById: openedBy.id,
        openingCash: TILL_OPENING_FLOAT,
        createdBy: SEED_ACTOR,
      },
    });
    for (const row of breakdownCash(TILL_OPENING_FLOAT)) {
      await prisma.tillCount.create({
        data: {
          tillId: till.id,
          denomination: row.denomination,
          quantity: row.quantity,
          amount: row.amount,
          isOpening: true,
        },
      });
    }

    const payments: PaymentRecord[] = [];
    let latestTime = firstOrderTime;

    for (const order of orders) {
      const totalDue = round2(order.lines.reduce((s, l) => s + l.netPrice + l.vatAmount, 0));
      const totalTax = round2(order.lines.reduce((s, l) => s + l.vatAmount, 0));

      const salesOrder = await prisma.salesOrder.create({
        data: {
          orderno: order.orderno,
          orderDate: order.date,
          status: order.isInvoiced ? "FULFILLED" : "ORDER",
          customerId: order.customerId,
          salesperson: order.designer.displayName,
          salesPersonId: order.designer.id,
          storeLocation: null,
          storeLocationId: storeId,
          taxDistrictId,
          totalTax,
          totalPaid: totalDue,
          dispatchStatus: order.isInvoiced ? "FULFILLED" : "SCHEDULED_DELIVERY",
          deliveryMethod: order.isInvoiced ? "TAKEN" : "DELIVERY",
          createdBy: SEED_ACTOR,
        },
      });
      result.ordersCreated += 1;

      await prisma.orderLineItem.createMany({
        data: order.lines.map((l, i) => {
          const product = productById.get(l.productId)!;
          return {
            salesOrderId: salesOrder.id,
            lineNumber: i + 1,
            partNo: product.productNumber,
            productName: product.name,
            orderedQuantity: l.quantity,
            netPrice: l.netPrice,
            cost: l.cost,
            vatRate: order.isTaxExempt ? 0 : 0.0635,
            vatAmount: l.vatAmount,
            productId: product.id,
            taxDistrictId,
            source: order.isInvoiced ? "FLOOR" : "ORDER",
            fulfillment: order.isInvoiced ? "TAKE" : "DELIVERY",
          };
        }),
      });

      if (order.isInvoiced) {
        await prisma.invoice.create({
          data: {
            invoiceNo: `INV-${order.orderno.replace("SO-", "")}`,
            invoiceDate: order.date,
            taxAmount: totalTax,
            salesOrderId: salesOrder.id,
          },
        });
        result.invoicesCreated += 1;
      }

      // --- Original payment -------------------------------------------
      const paymentType = METHOD_DISPLAY[order.method];
      let giftCardId: number | undefined;

      if (order.method === "GIFT_CARD") {
        const initialAmount = Math.max(25, Math.ceil(totalDue / 25) * 25);
        giftCardSeq += 1;
        const gc = await prisma.giftCard.create({
          data: {
            barcode: `GC-${giftCardSeq}`,
            initialAmount,
            currentBalance: initialAmount,
            status: "ACTIVE",
            activatedAt: new Date(order.date.getTime() - randInt(cashFlowRng, 1, 20) * 86_400_000),
            createdBy: SEED_ACTOR,
          },
        });
        const balanceAfter = round2(initialAmount - totalDue);
        await prisma.giftCardTransaction.create({
          data: {
            giftCardId: gc.id,
            transactionType: "REDEMPTION",
            amount: -totalDue,
            balanceBefore: initialAmount,
            balanceAfter,
            createdBy: SEED_ACTOR,
          },
        });
        await prisma.giftCard.update({
          where: { id: gc.id },
          data: { currentBalance: balanceAfter },
        });
        giftCardId = gc.id;
        result.giftCardsCreated += 1;
      }

      if (order.method === "STORE_CREDIT" && order.customerId) {
        await ensureStoreCredit(order.customerId, totalDue, order.date);
        const before = customerCreditBalance.get(order.customerId)!;
        const after = round2(before - totalDue);
        await prisma.customerCreditTransaction.create({
          data: {
            customerId: order.customerId,
            type: "USAGE",
            amount: -totalDue,
            balanceBefore: before,
            balanceAfter: after,
            salesOrderId: salesOrder.id,
            createdBy: SEED_ACTOR,
            created: order.date,
          },
        });
        customerCreditBalance.set(order.customerId, after);
        await prisma.customer.update({
          where: { id: order.customerId },
          data: { creditBalance: after },
        });
      }

      await prisma.payment.create({
        data: {
          salesOrderId: salesOrder.id,
          paymentDate: order.date,
          paymentType,
          paymentAmount: totalDue,
          status: "COMPLETED",
          method: order.method,
          registerId,
          tillId: till.id,
          staffMemberId: order.designer.id,
          customerId: order.customerId,
          giftCardId,
          storeLocationId: storeId,
          createdBy: SEED_ACTOR,
        },
      });
      result.paymentsCreated += 1;
      result.methodCounts[order.method] = (result.methodCounts[order.method] ?? 0) + 1;
      payments.push({ method: order.method, amount: totalDue, isRefund: false, time: order.date });
      if (order.date > latestTime) latestTime = order.date;

      // --- Same-day refund (invoiced orders only) ----------------------
      if (order.hasRefund) {
        const refundLine = order.lines[order.refundLineIndex];
        const refundAmount = round2(refundLine.netPrice + refundLine.vatAmount);
        const refundTime = sameDayLaterTime(cashFlowRng, order.date);

        await prisma.orderLineItem.create({
          data: {
            salesOrderId: salesOrder.id,
            lineNumber: order.lines.length + 1,
            partNo: productById.get(refundLine.productId)!.productNumber,
            productName: productById.get(refundLine.productId)!.name,
            orderedQuantity: refundLine.quantity,
            netPrice: -refundLine.netPrice,
            cost: -refundLine.cost,
            vatRate: order.isTaxExempt ? 0 : 0.0635,
            vatAmount: -refundLine.vatAmount,
            productId: refundLine.productId,
            taxDistrictId,
            source: "FLOOR",
            fulfillment: "TAKE",
          },
        });

        if (order.method === "GIFT_CARD" && giftCardId) {
          const gc = await prisma.giftCard.findUniqueOrThrow({ where: { id: giftCardId } });
          const before = Number(gc.currentBalance);
          const after = round2(before + refundAmount);
          await prisma.giftCardTransaction.create({
            data: {
              giftCardId,
              transactionType: "RELOAD",
              amount: refundAmount,
              balanceBefore: before,
              balanceAfter: after,
              notes: "Seeded same-day return",
              createdBy: SEED_ACTOR,
            },
          });
          await prisma.giftCard.update({
            where: { id: giftCardId },
            data: { currentBalance: after },
          });
        } else if (order.method === "STORE_CREDIT" && order.customerId) {
          const before = customerCreditBalance.get(order.customerId) ?? 0;
          const after = round2(before + refundAmount);
          await prisma.customerCreditTransaction.create({
            data: {
              customerId: order.customerId,
              type: "REFUND_CREDIT",
              amount: refundAmount,
              balanceBefore: before,
              balanceAfter: after,
              salesOrderId: salesOrder.id,
              notes: "Seeded same-day return",
              createdBy: SEED_ACTOR,
              created: refundTime,
            },
          });
          customerCreditBalance.set(order.customerId, after);
          await prisma.customer.update({
            where: { id: order.customerId },
            data: { creditBalance: after },
          });
        }

        await prisma.payment.create({
          data: {
            salesOrderId: salesOrder.id,
            paymentDate: refundTime,
            paymentType,
            paymentAmount: refundAmount,
            status: "COMPLETED",
            method: order.method,
            isRefund: true,
            refundReason: "Customer return — seeded demo data",
            registerId,
            tillId: till.id,
            staffMemberId: order.designer.id,
            customerId: order.customerId,
            giftCardId,
            storeLocationId: storeId,
            createdBy: SEED_ACTOR,
          },
        });
        result.paymentsCreated += 1;
        result.refundPaymentsCreated += 1;
        result.refundCount += 1;
        payments.push({
          method: order.method,
          amount: refundAmount,
          isRefund: true,
          time: refundTime,
        });
        if (refundTime > latestTime) latestTime = refundTime;

        await prisma.salesOrder.update({
          where: { id: salesOrder.id },
          data: { totalPaid: round2(totalDue - refundAmount) },
        });
      }
    }

    // --- Close the till (except the very last session, left OPEN) ------
    const cashDelta = payments.reduce((s, p) => {
      if (p.method !== "CASH") return s;
      return s + (p.isRefund ? -p.amount : p.amount);
    }, 0);
    const expectedCash = round2(TILL_OPENING_FLOAT + cashDelta);

    if (gi === openIdx) {
      result.tillsOpen += 1;
      result.openTillId = till.id;
      continue;
    }

    let variance: number;
    let note: string | null = null;
    if (gi === noteIdx) {
      variance = -12.5;
      note =
        "Drawer $12.50 short at close — recounted twice, could not locate the difference. Logged per policy.";
      result.forcedVariance.note = till.id;
    } else if (gi === managerIdx) {
      variance = 47.2;
      note =
        "Drawer $47.20 over at close. Manager notified and verified the recount before close-out.";
      result.forcedVariance.manager = till.id;
    } else if (gi === escalationIdx) {
      variance = -162.4;
      note =
        "Drawer $162.40 short at close. Escalated to management immediately; register locked pending investigation.";
      result.forcedVariance.escalation = till.id;
    } else {
      variance = round2(randFloat(varianceRng, -3, 3));
    }
    const actualCash = round2(expectedCash + variance);
    const classification = classifyTillVariance(variance);
    if (classification.requiresNote && !note) {
      note = `Variance of $${Math.abs(variance).toFixed(2)} at close — recounted, discrepancy confirmed.`;
    }

    const closedBy =
      staff.managers.find((m) => m.homeStoreId === storeId) ?? staff.managers[0] ?? openedBy;
    const closedAt = new Date(latestTime.getTime() + 20 * 60_000);

    await prisma.till.update({
      where: { id: till.id },
      data: {
        status: "CLOSED",
        closedAt,
        closedById: closedBy.id,
        expectedCash,
        actualCash,
        variance,
        notes: note,
      },
    });
    for (const row of breakdownCash(Math.max(0, actualCash))) {
      await prisma.tillCount.create({
        data: {
          tillId: till.id,
          denomination: row.denomination,
          quantity: row.quantity,
          amount: row.amount,
          isOpening: false,
        },
      });
    }
    result.tillsClosed += 1;

    if (classification.blocksRegister) {
      await applyRegisterVarianceBlock(prisma, {
        registerId,
        tillId: till.id,
        variance,
        classification,
      });
      result.blockedRegisterId = registerId;
    }
  }

  return result;
}
