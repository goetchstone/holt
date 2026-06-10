// /app/src/lib/journalEntry.ts

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

type Decimal = Prisma.Decimal;

export interface JournalLine {
  glAccountId: number;
  memo: string;
  debit: number;
  credit: number;
  sortOrder: number;
}

interface GenerateResult {
  journalEntry: {
    id: number;
    journalNumber: string;
    journalDate: Date;
    status: string;
    totalDebits: number;
    totalCredits: number;
    lines: {
      id: number;
      memo: string;
      glAccount: { id: number; code: string; name: string };
      debit: number;
      credit: number;
      sortOrder: number;
    }[];
  };
  warnings: string[];
}

export interface SalesPayment {
  amount: number;
  memo: string;
  glAccountId: number;
  glCode: string;
  order: SalesOrderForJournal | null;
}

export interface SalesOrderForJournal {
  id: number;
  hasInvoices: boolean;
  taxGlId: number | null;
  taxMemo: string;
  lineItems: SalesLineForJournal[];
}

export interface SalesLineForJournal {
  id: number;
  description: string;
  netPrice: number;
  cost: number;
  quantity: number;
  taxAmount: number;
  accountGroup: {
    name: string;
    salesGlId: number | null;
    cogsGlId: number | null;
    inventoryGlId: number | null;
  } | null;
}

export interface BuildResult {
  lines: JournalLine[];
  totalDebits: number;
  totalCredits: number;
  warnings: string[];
}

// GL codes that receive debits when cash is received
const CASH_GL_CODES = ["1-1006"];
// GL codes that receive credits when deposits are received
const DEPOSIT_GL_CODES = ["1-1200", "1-1203"];
// GL codes that receive debits when gift cards are redeemed (liability reduction)
const LIABILITY_DEBIT_CODES = ["2-2127"];

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toNum(d: Decimal | number | null | undefined): number {
  if (d === null || d === undefined) return 0;
  return typeof d === "number" ? d : Number(d);
}

export function formatJournalNumber(date: Date): string {
  // Format: SJ + YYYYMMDD (e.g. SJ20260501). 4-digit year by user
  // direction 2026-04-28 -- removes century-boundary ambiguity.
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  return `SJ${yyyy}${mm}${dd}`;
}

/**
 * Pure balance assertion for a set of journal lines. Returns ok=true when:
 *   1. The set is non-empty.
 *   2. Every line is well-formed: exactly one of {debit, credit} is non-zero.
 *      Both-set or both-zero lines are rejected as malformed (a row in
 *      `JournalEntryLine` either records a debit OR a credit, never both
 *      and never neither — buildJournalLines never emits these shapes,
 *      but a future hand-edit UI or import could).
 *   3. sum(debit) and sum(credit) agree to within half a penny (0.005).
 *      Floating-point tolerance prevents 1063.5 vs 1063.4999999999998
 *      false-failures while still catching any real imbalance.
 *
 * Used by the PUT endpoint at /api/accounting/journal-entries/[id] before
 * transitioning DRAFT -> POSTED. Without this guard, an unbalanced or
 * malformed JE could ship to QuickBooks and require manual correction.
 * Same defense applies on POSTED -> EXPORTED so any drift between the
 * two transitions is also caught.
 *
 * Origin: Phase 0 BLOCKER B4 from the SOR plan (2026-04-28). Per-line
 * validation added 2026-05-07 per Phase 0.6.4.
 */
export interface BalanceAssertion {
  ok: boolean;
  totalDebits: number;
  totalCredits: number;
  diff: number;
  error?: string;
}

export const BALANCE_TOLERANCE = 0.005;

export function assertBalanced(
  lines: ReadonlyArray<{ debit: number; credit: number }>,
): BalanceAssertion {
  if (lines.length === 0) {
    return {
      ok: false,
      totalDebits: 0,
      totalCredits: 0,
      diff: 0,
      error: "Refusing to post a journal entry with zero lines",
    };
  }
  // Per-line shape validation. A well-formed JE line records exactly one
  // side: either a non-zero debit OR a non-zero credit, not both, not
  // neither. Catches malformed rows before they reach the GL.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const d = round2(l.debit || 0);
    const c = round2(l.credit || 0);
    const debitSet = Math.abs(d) > BALANCE_TOLERANCE;
    const creditSet = Math.abs(c) > BALANCE_TOLERANCE;
    if (debitSet && creditSet) {
      return {
        ok: false,
        totalDebits: 0,
        totalCredits: 0,
        diff: 0,
        error: `Malformed journal line ${i}: both debit (${d.toFixed(2)}) and credit (${c.toFixed(2)}) are set; exactly one side must be non-zero`,
      };
    }
    if (!debitSet && !creditSet) {
      return {
        ok: false,
        totalDebits: 0,
        totalCredits: 0,
        diff: 0,
        error: `Malformed journal line ${i}: both debit and credit are zero; exactly one side must be non-zero`,
      };
    }
  }
  const totalDebits = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const totalCredits = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  const diff = round2(totalDebits - totalCredits);
  if (Math.abs(diff) > BALANCE_TOLERANCE) {
    return {
      ok: false,
      totalDebits,
      totalCredits,
      diff,
      error: `Journal entry is out of balance: debits ${totalDebits.toFixed(2)}, credits ${totalCredits.toFixed(2)}, diff ${diff.toFixed(2)}`,
    };
  }
  return { ok: true, totalDebits, totalCredits, diff };
}

function isDepositGl(code: string): boolean {
  return DEPOSIT_GL_CODES.includes(code);
}

function isCashGl(code: string): boolean {
  return CASH_GL_CODES.includes(code);
}

function isLiabilityDebitGl(code: string): boolean {
  return LIABILITY_DEBIT_CODES.includes(code);
}

/**
 * Translates a signed accumulator amount into the right debit/credit pair.
 *
 * Sign convention:
 *   amount > 0 → entry hits its DEFAULT side (e.g. revenue → credit, COGS → debit)
 *   amount < 0 → entry hits the OPPOSITE side (a return: revenue is debited, COGS is credited)
 *   amount = 0 → no line emitted
 *
 * This is the keystone helper for B3 of the SOR plan (returns as
 * sale-in-reverse). Without sign-flipping on the inventory / tax / revenue
 * / COGS emit blocks, returns produce JE rows with negative debit or
 * negative credit amounts -- which QuickBooks rejects on import. The
 * helper makes the behavior uniform across all emit blocks instead of
 * having sign-flip code duplicated in some sections and missing in others.
 *
 * Origin: Phase 0 BLOCKER B3 from the SOR plan (2026-04-28).
 */
function pickSide(defaultSide: "debit" | "credit", signedAmount: number): "debit" | "credit" {
  if (signedAmount > 0) return defaultSide;
  return defaultSide === "debit" ? "credit" : "debit";
}

function emitSigned(
  glAccountId: number,
  memo: string,
  signedAmount: number,
  defaultSide: "debit" | "credit",
  sortOrder: number,
): JournalLine | null {
  if (signedAmount === 0) return null;
  const positive = round2(Math.abs(signedAmount));
  const finalSide = pickSide(defaultSide, signedAmount);
  if (finalSide === "debit") {
    return { glAccountId, memo, debit: positive, credit: 0, sortOrder };
  }
  return { glAccountId, memo, debit: 0, credit: positive, sortOrder };
}

export function buildJournalLines(
  payments: SalesPayment[],
  overShortGlId: number | null,
  depositGlId: number | null,
): BuildResult {
  const warnings: string[] = [];

  const paymentDebits = new Map<number, { memo: string; amount: number }>();
  const paymentCredits = new Map<number, { memo: string; amount: number }>();
  const revenueCredits = new Map<number, { memo: string; amount: number }>();
  const cogsDebits = new Map<number, { memo: string; amount: number }>();
  const inventoryCredits = new Map<number, { memo: string; amount: number }>();
  const taxCredits = new Map<number, { memo: string; amount: number }>();

  const processedOrders = new Set<number>();

  for (const payment of payments) {
    const { amount, memo, glAccountId, glCode } = payment;

    if (isCashGl(glCode)) {
      const acc = paymentDebits.get(glAccountId) || { memo, amount: 0 };
      acc.amount = round2(acc.amount + amount);
      paymentDebits.set(glAccountId, acc);
    } else if (isDepositGl(glCode)) {
      const acc = paymentCredits.get(glAccountId) || { memo: "Pmt On Acct", amount: 0 };
      acc.amount = round2(acc.amount + amount);
      paymentCredits.set(glAccountId, acc);
    } else if (isLiabilityDebitGl(glCode)) {
      const acc = paymentDebits.get(glAccountId) || { memo: "GC Redeem", amount: 0 };
      acc.amount = round2(acc.amount + amount);
      paymentDebits.set(glAccountId, acc);
    } else {
      const acc = paymentDebits.get(glAccountId) || { memo, amount: 0 };
      acc.amount = round2(acc.amount + amount);
      paymentDebits.set(glAccountId, acc);
    }

    const order = payment.order;
    if (!order || processedOrders.has(order.id)) continue;

    if (!order.hasInvoices) {
      // Deposit only: if payment was to a cash account, create offsetting deposit credit
      if (isCashGl(glCode) && depositGlId) {
        const acc = paymentCredits.get(depositGlId) || { memo: "Pmt On Acct", amount: 0 };
        acc.amount = round2(acc.amount + amount);
        paymentCredits.set(depositGlId, acc);
      }
      continue;
    }

    processedOrders.add(order.id);

    for (const li of order.lineItems) {
      if (!li.accountGroup) {
        warnings.push(`Line item "${li.description}" has no account group mapping`);
        continue;
      }

      const { salesGlId, cogsGlId, inventoryGlId, name: groupName } = li.accountGroup;

      // Revenue (credit) — netPrice is the LINE TOTAL, do not multiply by quantity
      if (salesGlId) {
        const lineRevenue = round2(li.netPrice);
        const acc = revenueCredits.get(salesGlId) || { memo: groupName, amount: 0 };
        acc.amount = round2(acc.amount + lineRevenue);
        revenueCredits.set(salesGlId, acc);
      } else {
        warnings.push(`Account group "${groupName}" has no sales GL account`);
      }

      // COGS (debit) — cost is the LINE COST (already multiplied by quantity)
      if (cogsGlId) {
        const lineCogs = round2(li.cost);
        const acc = cogsDebits.get(cogsGlId) || { memo: groupName, amount: 0 };
        acc.amount = round2(acc.amount + lineCogs);
        cogsDebits.set(cogsGlId, acc);
      }

      // Inventory (credit -- reducing the asset) — cost is the LINE COST
      if (inventoryGlId) {
        const lineInv = round2(li.cost);
        const acc = inventoryCredits.get(inventoryGlId) || { memo: groupName, amount: 0 };
        acc.amount = round2(acc.amount + lineInv);
        inventoryCredits.set(inventoryGlId, acc);
      }

      // Tax (credit)
      if (li.taxAmount !== 0) {
        if (order.taxGlId) {
          const acc = taxCredits.get(order.taxGlId) || { memo: order.taxMemo, amount: 0 };
          acc.amount = round2(acc.amount + li.taxAmount);
          taxCredits.set(order.taxGlId, acc);
        } else {
          warnings.push(`No tax GL account for district "${order.taxMemo}"`);
        }
      }
    }
  }

  // Build journal lines. emitSigned() handles the sign convention
  // uniformly: positive amounts go on the default side; negative
  // amounts (returns / refunds) flip to the opposite side. Without
  // this, returns produce invalid negative-credit / negative-debit
  // rows that QuickBooks rejects (B3).
  const lines: JournalLine[] = [];
  const emitInto = (
    map: Map<number, { memo: string; amount: number }>,
    defaultSide: "debit" | "credit",
    sortOrder: number,
  ) => {
    for (const [glAccountId, { memo, amount }] of map) {
      const line = emitSigned(glAccountId, memo, amount, defaultSide, sortOrder);
      if (line) lines.push(line);
    }
  };

  emitInto(paymentDebits, "debit", 10); // cash/card receipts, GC redemptions
  emitInto(paymentCredits, "credit", 20); // deposits, on-account
  emitInto(inventoryCredits, "credit", 30); // by department
  emitInto(taxCredits, "credit", 40); // by district
  emitInto(revenueCredits, "credit", 50); // by department
  emitInto(cogsDebits, "debit", 60); // by department

  // Check balance
  let totalDebits = round2(lines.reduce((sum, l) => sum + l.debit, 0));
  let totalCredits = round2(lines.reduce((sum, l) => sum + l.credit, 0));

  const diff = round2(totalDebits - totalCredits);
  if (diff !== 0 && overShortGlId) {
    if (diff > 0) {
      lines.push({
        glAccountId: overShortGlId,
        memo: "Over/Short",
        debit: 0,
        credit: diff,
        sortOrder: 70,
      });
      totalCredits = round2(totalCredits + diff);
    } else {
      lines.push({
        glAccountId: overShortGlId,
        memo: "Over/Short",
        debit: round2(-diff),
        credit: 0,
        sortOrder: 70,
      });
      totalDebits = round2(totalDebits + round2(-diff));
    }
  } else if (diff !== 0) {
    warnings.push(
      `Journal is out of balance by $${diff.toFixed(2)} and no Over/Short GL is configured`,
    );
  }

  return { lines, totalDebits, totalCredits, warnings };
}

export async function generateSalesJournal(
  date: Date,
  createdBy?: string,
  storeLocation?: string,
): Promise<GenerateResult> {
  const journalNumber = formatJournalNumber(date);
  const warnings: string[] = [];

  // Check for existing entry
  const existing = await prisma.journalEntry.findUnique({
    where: { journalNumber },
  });

  if (existing) {
    if (existing.status !== "DRAFT") {
      throw new Error(
        `Journal ${journalNumber} already exists with status ${existing.status} and cannot be regenerated`,
      );
    }
    await prisma.journalEntry.delete({ where: { id: existing.id } });
  }

  // Date range for the target day (midnight to midnight UTC)
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  // Load system GL mappings for payment types
  const paymentMappings = await prisma.systemGLMapping.findMany({
    where: { section: "POS_PAYMENTS" },
    include: { glAccount: { select: { id: true, code: true, name: true } } },
  });

  const paymentGlMap = new Map<string, { glAccountId: number; code: string }>();
  for (const m of paymentMappings) {
    if (m.glAccount) {
      paymentGlMap.set(m.label.toLowerCase(), {
        glAccountId: m.glAccount.id,
        code: m.glAccount.code,
      });
    }
  }

  // Load fallback tax GL (Sales Tax from POS_TRANSACTIONS)
  const taxMapping = await prisma.systemGLMapping.findUnique({
    where: { section_label: { section: "POS_TRANSACTIONS", label: "Sales Tax" } },
    include: { glAccount: { select: { id: true, code: true, name: true } } },
  });
  const fallbackTaxGlId = taxMapping?.glAccount?.id || null;

  // Load Over/Short GL for balancing
  const overShortMapping = await prisma.systemGLMapping.findUnique({
    where: { section_label: { section: "POS_TRANSACTIONS", label: "Over/Short" } },
    include: { glAccount: { select: { id: true, code: true, name: true } } },
  });
  const overShortGlId = overShortMapping?.glAccount?.id || null;

  // Resolve deposit GL for offset on cash payments without invoices
  const depositMapping = paymentGlMap.get("on account") || paymentGlMap.get("deposit") || null;
  const depositGlId = depositMapping?.glAccountId || null;

  // Query all payments for the date
  const paymentWhere: Record<string, unknown> = {
    paymentDate: { gte: dayStart, lte: dayEnd },
  };
  if (storeLocation) {
    paymentWhere.storeLocation = storeLocation;
  }

  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    include: {
      applications: { select: { id: true } },
      salesOrder: {
        include: {
          invoices: { select: { id: true } },
          taxDistrict: {
            select: { id: true, shortName: true, glAccountId: true },
          },
          lineItems: {
            // CLAUDE.md rule 33: cancelled lines must never inflate the
            // journal entry. After PR #121 changed the sales import
            // orphan-cleanup from deleteMany to updateMany SET CANCELLED,
            // cancelled rows persist in the table -- they would otherwise
            // double-count into Sales / COGS / Inventory / Tax. Same bug
            // class as the $405 Detailed Sales discrepancy fixed in PR
            // #125; this is the JE-side closure of that surface.
            where: { lineItemStatus: { not: "CANCELLED" } },
            include: {
              product: {
                include: {
                  category: {
                    include: {
                      accountGroup: {
                        include: {
                          salesAccount: { select: { id: true, code: true, name: true } },
                          cogsAccount: { select: { id: true, code: true, name: true } },
                          inventoryAccount: { select: { id: true, code: true, name: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (payments.length === 0) {
    throw new Error(`No payments found for ${journalNumber} (${date.toLocaleDateString()})`);
  }

  // Map Prisma data to plain types for the pure build function
  const mappedPayments: SalesPayment[] = [];
  for (const payment of payments) {
    const amount = toNum(payment.paymentAmount);
    if (amount === 0) continue;

    // Authored-invoice payments (no sales order, applied to an invoice) post
    // their own AR_PAYMENT journal at application time (lib/billing/
    // invoiceService.ts) — including them here would credit the deposit GL
    // instead of relieving AR, and double-count cash.
    if (payment.salesOrderId === null && payment.applications.length > 0) continue;

    const typeKey = (payment.paymentType || "").toLowerCase().trim();
    const mapping = paymentGlMap.get(typeKey);

    if (!mapping) {
      warnings.push(`Unmapped payment type "${payment.paymentType}" ($${amount.toFixed(2)})`);
      continue;
    }

    mappedPayments.push({
      amount,
      memo: payment.paymentType || "Unknown",
      glAccountId: mapping.glAccountId,
      glCode: mapping.code,
      order: payment.salesOrder
        ? {
            id: payment.salesOrder.id,
            hasInvoices: (payment.salesOrder.invoices?.length || 0) > 0,
            taxGlId: payment.salesOrder.taxDistrict?.glAccountId || fallbackTaxGlId,
            taxMemo: payment.salesOrder.taxDistrict?.shortName || "Tax",
            lineItems: payment.salesOrder.lineItems.map((li) => ({
              id: li.id,
              description: li.productName || li.partNo || `line ${li.id}`,
              netPrice: toNum(li.netPrice),
              cost: toNum(li.cost),
              quantity: toNum(li.orderedQuantity),
              taxAmount: toNum(li.vatAmount),
              accountGroup: li.product?.category?.accountGroup
                ? {
                    name: li.product.category.accountGroup.name,
                    salesGlId: li.product.category.accountGroup.salesAccount?.id || null,
                    cogsGlId: li.product.category.accountGroup.cogsAccount?.id || null,
                    inventoryGlId: li.product.category.accountGroup.inventoryAccount?.id || null,
                  }
                : null,
            })),
          }
        : null,
    });
  }

  const result = buildJournalLines(mappedPayments, overShortGlId, depositGlId);
  warnings.push(...result.warnings);

  // #138: never persist an unbalanced entry. Assert before the write so a builder
  // bug surfaces with context here, not as a raw DB constraint error later.
  const balance = assertBalanced(result.lines);
  if (!balance.ok) {
    throw new Error(balance.error ?? "Journal entry is out of balance");
  }

  // Create the journal entry in a transaction
  const entry = await prisma.$transaction(async (tx) => {
    const je = await tx.journalEntry.create({
      data: {
        journalNumber,
        journalDate: dayStart,
        journalType: "SALES",
        status: "DRAFT",
        storeLocation: storeLocation || null,
        totalDebits: result.totalDebits,
        totalCredits: result.totalCredits,
        createdBy: createdBy || null,
        lines: {
          create: result.lines.map((l) => ({
            glAccountId: l.glAccountId,
            memo: l.memo,
            debit: l.debit,
            credit: l.credit,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: {
        lines: {
          orderBy: { sortOrder: "asc" },
          include: {
            glAccount: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
    return je;
  });

  return {
    journalEntry: {
      id: entry.id,
      journalNumber: entry.journalNumber,
      journalDate: entry.journalDate,
      status: entry.status,
      totalDebits: Number(entry.totalDebits),
      totalCredits: Number(entry.totalCredits),
      lines: entry.lines.map((l) => ({
        id: l.id,
        memo: l.memo,
        glAccount: l.glAccount,
        debit: Number(l.debit),
        credit: Number(l.credit),
        sortOrder: l.sortOrder,
      })),
    },
    warnings,
  };
}
