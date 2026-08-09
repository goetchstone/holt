// /app/src/lib/journalEntry.ts

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { reportOpsAlert } from "@/lib/opsAlert";
import {
  POS_PAYMENTS_SECTION,
  POS_TRANSACTIONS_SECTION,
  SALES_TAX_MAPPING_LABEL,
  OVER_SHORT_MAPPING_LABEL,
  OVER_SHORT_ALERT_THRESHOLD,
} from "@/lib/glMapping";
import { businessDayRange, getBusinessTimeZone } from "@/lib/reports/businessDay";

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
  /**
   * `Payment.originalPaymentId` -- set only by `paymentService.processRefund`,
   * which writes a refund row pointing at the ORIGINAL SalesOrder. A payment
   * carrying this must not re-recognize that order's line items: they were
   * already booked on the day the sale posted. See the guard in
   * `buildJournalLines` and docs/domains/accounting.md "Native refunds".
   *
   * Deliberately NOT `isRefund`. Imported POS returns also set `isRefund`, but
   * they hang off their own return-order whose OrderLineItems are negative and
   * have never been booked -- those must still flow through the B3
   * sale-in-reverse path. `originalPaymentId` is the recorded fact that
   * separates the two (CLAUDE.md rule 60).
   */
  reversesPaymentId?: number | null;
}

export interface SalesOrderForJournal {
  id: number;
  hasInvoices: boolean;
  taxGlId: number | null;
  taxMemo: string;
  lineItems: SalesLineForJournal[];
  // ERP-native Return records tied to this order (B3 classified-return
  // branching). Optional/undefined for callers that predate this field
  // (existing unit-test fixtures) -- treated the same as an empty array.
  returns?: ReturnForJournal[];
}

export interface SalesLineForJournal {
  id: number;
  description: string;
  netPrice: number;
  cost: number;
  quantity: number;
  taxAmount: number;
  // Used to correlate a return-shaped (negative) line to a Return record
  // when there's no direct lineItemId FK (the common case for imported
  // returns). Optional so pre-existing fixtures without a productId still
  // type-check; matching degrades gracefully when absent (see
  // matchReturnForLine).
  productId?: number | null;
  accountGroup: {
    name: string;
    salesGlId: number | null;
    cogsGlId: number | null;
    inventoryGlId: number | null;
    // Write-off / shrinkage GL for the department. Wired in for B3 classified
    // WRITTEN_OFF returns -- previously modeled on AccountGroup but not
    // consumed by the JE generator (see docs/domains/accounting.md gap list,
    // "Shrinkage JE workflow"). Optional so existing fixtures without it
    // still type-check.
    shrinkageGlId?: number | null;
  } | null;
}

// ─── B3: classified vs. default-restock returns ─────────────────────────
//
// The ERP-native `Return` model (prisma model `Return`) captures a
// restock-vs-writeoff decision via `inspectionCondition` / terminal
// `status`. Historical imported POS returns have NO corresponding `Return`
// row at all (docs/domains/returns.md "the dual reality") -- for those, and
// for any Return that hasn't been classified yet, the owner-directed default
// applies: assume restock. This section makes that default an explicit,
// named, testable code path instead of an implicit fallthrough.

/** Minimal shape of a `Return` row needed to classify its JE disposition. */
export interface ReturnForJournal {
  id: number;
  lineItemId: number | null;
  productId: number | null;
  status: string; // Prisma `ReturnStatus`
  inspectionCondition: string | null; // Prisma `InspectionCondition` | null
}

export type ReturnDisposition = "RESTOCK" | "WRITEOFF";

/**
 * Booking path for a return-shaped (negative-cost) line item. The two
 * RESTOCK paths book identically in the JE (inventory comes back) -- they're
 * kept as distinct names so callers (the JE builder AND the "Unclassified
 * Returns" exception report) can tell "we know this is a restock" apart from
 * "we're assuming restock because nobody classified it."
 */
export type ReturnBookingPath =
  "CLASSIFIED_RESTOCK" | "CLASSIFIED_WRITEOFF" | "UNCLASSIFIED_DEFAULT_RESTOCK";

/**
 * Maps a matched Return record to a restock/writeoff disposition, or null
 * when the record doesn't carry enough signal yet to decide (not yet
 * inspected). Terminal status (RESTOCKED / WRITTEN_OFF) wins when present --
 * a human already made the call. Otherwise falls back to the inspection-
 * condition heuristic, mirroring `suggestDisposition` in
 * `lib/returnService.ts` (LIKE_NEW / MINOR_DAMAGE -> restock; MAJOR_DAMAGE /
 * UNSALVAGEABLE -> writeoff).
 */
export function classifyReturnDisposition(
  ret: ReturnForJournal | null | undefined,
): ReturnDisposition | null {
  if (!ret) return null;
  if (ret.status === "RESTOCKED") return "RESTOCK";
  if (ret.status === "WRITTEN_OFF") return "WRITEOFF";
  switch (ret.inspectionCondition) {
    case "LIKE_NEW":
    case "MINOR_DAMAGE":
      return "RESTOCK";
    case "MAJOR_DAMAGE":
    case "UNSALVAGEABLE":
      return "WRITEOFF";
    default:
      return null;
  }
}

/**
 * Correlates a return-shaped line item to the Return record that covers it.
 * There is no direct FK from a return-shaped OrderLineItem to a Return row
 * (Return.lineItemId references the ORIGINAL sale's line item, not the
 * negative return line -- see docs/domains/returns.md "the dual reality").
 * So this tries progressively looser matches, in order of confidence:
 *
 *   1. Exact FK: a Return whose lineItemId is literally this line's id
 *      (future-proofing -- covers a direct link if one is ever added).
 *   2. Same product on the same order: unambiguous when exactly one Return
 *      on the order names this product.
 *   3. Sole Return on the order: nothing else to disambiguate with, and
 *      there's only one candidate.
 *
 * Returns null (ambiguous or no candidate) when none of those hold --
 * callers fall back to the unclassified default.
 */
export function matchReturnForLine(
  line: { id: number; productId?: number | null },
  returns: ReadonlyArray<ReturnForJournal> | null | undefined,
): ReturnForJournal | null {
  if (!returns || returns.length === 0) return null;

  const exact = returns.find((r) => r.lineItemId === line.id);
  if (exact) return exact;

  if (line.productId != null) {
    const byProduct = returns.filter((r) => r.productId === line.productId);
    if (byProduct.length === 1) return byProduct[0];
    // At least one Return on the order names a SPECIFIC (non-null) product
    // and none of them is this line's product -- don't fall through to the
    // "sole Return" heuristic below, which would mis-attribute a different
    // product's classification onto this line.
    if (returns.some((r) => r.productId != null)) return null;
  }

  if (returns.length === 1) return returns[0];

  return null;
}

/**
 * Resolves the full B3 booking-path decision for a return-shaped line item:
 * match it to a Return record, then classify that record's disposition.
 * Falls back to UNCLASSIFIED_DEFAULT_RESTOCK whenever there's no match or
 * the matched Return isn't classified yet -- the owner-directed default
 * (2026-04-28: "returns aren't shrinkage -- they're sales in reverse," all
 * imported returns assumed restock unless proven otherwise).
 */
export function resolveReturnBookingPath(
  line: { id: number; productId?: number | null },
  returns: ReadonlyArray<ReturnForJournal> | null | undefined,
): ReturnBookingPath {
  const matched = matchReturnForLine(line, returns);
  const disposition = classifyReturnDisposition(matched);
  if (disposition === "RESTOCK") return "CLASSIFIED_RESTOCK";
  if (disposition === "WRITEOFF") return "CLASSIFIED_WRITEOFF";
  return "UNCLASSIFIED_DEFAULT_RESTOCK";
}

export interface BuildResult {
  lines: JournalLine[];
  totalDebits: number;
  totalCredits: number;
  warnings: string[];
  /**
   * The imbalance the Over/Short plug absorbed, signed the same way the
   * builder computes it: `totalDebits - totalCredits` BEFORE the plug line
   * was appended. Positive = debits exceeded credits (plug is a credit);
   * negative = credits exceeded debits (plug is a debit). 0 when no plug
   * fired, including when the journal was already balanced.
   *
   * Exposed because `assertBalanced` cannot see this: once the plug is in,
   * the entry balances perfectly. This number is the only evidence left that
   * it did not balance on its own.
   */
  overShort: number;
}

// KNOWN GAP (CLAUDE.md rule 61) -- these three arrays are Holt's own chart of
// accounts hardcoded in product source, the same class of bug that was just
// removed from lib/dailyReconciliation.ts. A deployment numbering its cash
// account anything other than "1-1006" gets every tender treated as the
// generic `else` branch below: cash receipts still post, but the deposit
// offset for an un-invoiced order and the gift-card liability debit both stop
// happening, silently.
//
// NOT fixed here, deliberately. Unlike the reconciliation's read-only
// classification, these decide what the generator WRITES to the books:
// re-deriving them from SystemGLMapping changes which tender is treated as
// cash vs. deposit vs. liability, which is a behavioural change to journal
// generation and wants its own change with its own before/after on real
// production tenders. Tracked rather than promised verbally (rule 50).
//
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
  //
  // UTC getters, deliberately. `date` here is a DATE MARKER -- UTC midnight of
  // a calendar day, which is how parseRange, enumerateDays and journalDate all
  // carry a business date. Reading a marker with getFullYear/getMonth/getDate
  // reads it in the SERVER's timezone, so on any host west of UTC
  // `new Date("2026-06-09T00:00:00Z").getDate()` is 8, and the June 9 journal
  // is numbered SJ20260608. That was invisible only because the containers set
  // no TZ and default to UTC; it broke on a developer's machine.
  const yyyy = date.getUTCFullYear().toString();
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
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
  /** Names the journal in plug warnings, e.g. "SJ20260501". */
  journalLabel: string = "this journal",
): BuildResult {
  const warnings: string[] = [];

  const paymentDebits = new Map<number, { memo: string; amount: number }>();
  const paymentCredits = new Map<number, { memo: string; amount: number }>();
  const revenueCredits = new Map<number, { memo: string; amount: number }>();
  const cogsDebits = new Map<number, { memo: string; amount: number }>();
  const inventoryCredits = new Map<number, { memo: string; amount: number }>();
  const taxCredits = new Map<number, { memo: string; amount: number }>();
  // B3 classified-writeoff line: debit magnitude only (never sign-flipped --
  // this map only ever receives return-writeoff cost, there's no "sale" of a
  // write-off to reverse). See resolveReturnBookingPath.
  const writeoffDebits = new Map<number, { memo: string; amount: number }>();

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

    // A native ERP refund (paymentService.processRefund) points at the
    // ORIGINAL SalesOrder, whose line items are the original POSITIVE sale
    // lines. Recognizing them here booked the whole sale a SECOND time -- same
    // direction as the original, so revenue was credited twice for one sale,
    // COGS debited twice, inventory relieved twice. The resulting imbalance
    // then vanished into the Over/Short plug.
    //
    // The cash leg above is the entire correct effect of a native refund. The
    // reversing revenue/COGS/tax legs, when they exist, come from return-shaped
    // (negative) OrderLineItems on a return order -- the B3 path -- which is
    // why this is keyed on `reversesPaymentId` and not on `isRefund`.
    //
    // Note this deliberately does NOT mark the order processed: a normal
    // payment for the same order on the same day must still recognize it,
    // whichever order the two rows happen to arrive in.
    if (payment.reversesPaymentId != null) continue;

    processedOrders.add(order.id);

    for (const li of order.lineItems) {
      if (!li.accountGroup) {
        warnings.push(`Line item "${li.description}" has no account group mapping`);
        continue;
      }

      const {
        salesGlId,
        cogsGlId,
        inventoryGlId,
        shrinkageGlId,
        name: groupName,
      } = li.accountGroup;

      // Revenue (credit) — netPrice is the LINE TOTAL, do not multiply by quantity
      if (salesGlId) {
        const lineRevenue = round2(li.netPrice);
        const acc = revenueCredits.get(salesGlId) || { memo: groupName, amount: 0 };
        acc.amount = round2(acc.amount + lineRevenue);
        revenueCredits.set(salesGlId, acc);
      } else {
        warnings.push(`Account group "${groupName}" has no sales GL account`);
      }

      // COGS (debit) — cost is the LINE COST (already multiplied by quantity).
      // Unchanged by the B3 restock/writeoff branch below: a return always
      // reverses the original COGS debit, regardless of what happens to the
      // physical inventory.
      if (cogsGlId) {
        const lineCogs = round2(li.cost);
        const acc = cogsDebits.get(cogsGlId) || { memo: groupName, amount: 0 };
        acc.amount = round2(acc.amount + lineCogs);
        cogsDebits.set(cogsGlId, acc);
      }

      // Inventory (credit -- reducing the asset) — cost is the LINE COST.
      //
      // B3: a NEGATIVE line here is a return. Per docs/domains/returns.md
      // ("Accounting view — returns are sales-in-reverse"), a return either
      // restocks (debit Inventory, via the sign-flip below) or writes off
      // (debit the department's Loss/Shrinkage GL instead, no inventory
      // movement -- the item never re-enters sellable stock). Which branch
      // applies is resolved by resolveReturnBookingPath: a classified
      // ERP-native Return record (inspectionCondition / terminal status)
      // wins; everything else -- including every imported POS return, which
      // carries no Return record at all -- takes the named
      // UNCLASSIFIED_DEFAULT_RESTOCK path (owner direction 2026-04-28).
      const lineInv = round2(li.cost);
      if (lineInv < 0) {
        // Return-shaped line. Resolve restock vs. writeoff BEFORE touching
        // either GL — writeoff routes to the shrinkage GL and deliberately
        // does NOT require inventoryGlId (a write-off never moves inventory).
        const path = resolveReturnBookingPath(
          { id: li.id, productId: li.productId },
          order.returns,
        );
        if (path === "CLASSIFIED_WRITEOFF" && shrinkageGlId) {
          const acc = writeoffDebits.get(shrinkageGlId) || {
            memo: `${groupName} Write-off`,
            amount: 0,
          };
          acc.amount = round2(acc.amount + Math.abs(lineInv));
          writeoffDebits.set(shrinkageGlId, acc);
        } else {
          if (path === "CLASSIFIED_WRITEOFF") {
            warnings.push(
              `Return on line "${li.description}" is classified WRITTEN_OFF but account group "${groupName}" has no shrinkage/write-off GL configured -- booked as restock instead`,
            );
          }
          if (inventoryGlId) {
            const acc = inventoryCredits.get(inventoryGlId) || { memo: groupName, amount: 0 };
            acc.amount = round2(acc.amount + lineInv);
            inventoryCredits.set(inventoryGlId, acc);
          }
        }
      } else if (inventoryGlId) {
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
  emitInto(writeoffDebits, "debit", 35); // B3 classified-writeoff returns, by department
  emitInto(taxCredits, "credit", 40); // by district
  emitInto(revenueCredits, "credit", 50); // by department
  emitInto(cogsDebits, "debit", 60); // by department

  // Check balance
  let totalDebits = round2(lines.reduce((sum, l) => sum + l.debit, 0));
  let totalCredits = round2(lines.reduce((sum, l) => sum + l.credit, 0));

  // The plug is never silent.
  //
  // It used to be: when an Over/Short GL was configured the builder pushed a
  // balancing line and NOTHING to `warnings`, so a $50,000 discrepancy came
  // back as a journal that "balanced." Configuring the account made the system
  // quieter rather than safer -- the only warning in the whole function fired
  // when Over/Short was ABSENT. `assertBalanced` cannot catch this either,
  // because after the plug the entry genuinely balances.
  const diff = round2(totalDebits - totalCredits);
  let overShort = 0;
  if (diff !== 0 && overShortGlId) {
    overShort = diff;
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
    const magnitude = Math.abs(diff);
    const side = diff > 0 ? "credit" : "debit";
    warnings.push(
      `Over/Short plug of $${magnitude.toFixed(2)} (${side}) was added to ${journalLabel} to force it into balance. ` +
        (magnitude > OVER_SHORT_ALERT_THRESHOLD
          ? `That is above the $${OVER_SHORT_ALERT_THRESHOLD.toFixed(2)} review threshold — a payment or a line item is probably missing. Do not export until it is explained.`
          : `Within the $${OVER_SHORT_ALERT_THRESHOLD.toFixed(2)} rounding threshold.`),
    );
  } else if (diff !== 0) {
    warnings.push(
      `Journal is out of balance by $${diff.toFixed(2)} and no Over/Short GL is configured`,
    );
  }

  return { lines, totalDebits, totalCredits, warnings, overShort };
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

  // The BUSINESS day this journal covers, not a UTC day and not a server-local
  // one. `date` arrives as a UTC-midnight marker; businessDayRange turns that
  // calendar date into the half-open instant window the deployment actually
  // traded over (lib/reports/businessDay.ts).
  //
  // This was `setHours(0,0,0,0)` under a comment claiming UTC. setHours is
  // SERVER-LOCAL, so the journal's window depended on the host's TZ; it matched
  // the comment only because the containers set no TZ and default to UTC. The
  // reconciliation compared that window against its own UTC-day window, so the
  // two could agree only on a UTC deployment -- and Saybrook is
  // America/New_York.
  const timeZone = await getBusinessTimeZone();
  const dayKey = date.toISOString().slice(0, 10);
  const { gte: dayStart, lt: dayEndExclusive } = businessDayRange(dayKey, timeZone);

  // Load system GL mappings for payment types
  const paymentMappings = await prisma.systemGLMapping.findMany({
    where: { section: POS_PAYMENTS_SECTION },
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
    where: {
      section_label: {
        section: POS_TRANSACTIONS_SECTION,
        label: SALES_TAX_MAPPING_LABEL,
      },
    },
    include: { glAccount: { select: { id: true, code: true, name: true } } },
  });
  const fallbackTaxGlId = taxMapping?.glAccount?.id || null;

  // Load Over/Short GL for balancing
  const overShortMapping = await prisma.systemGLMapping.findUnique({
    where: {
      section_label: {
        section: POS_TRANSACTIONS_SECTION,
        label: OVER_SHORT_MAPPING_LABEL,
      },
    },
    include: { glAccount: { select: { id: true, code: true, name: true } } },
  });
  const overShortGlId = overShortMapping?.glAccount?.id || null;

  // Resolve deposit GL for offset on cash payments without invoices
  const depositMapping = paymentGlMap.get("on account") || paymentGlMap.get("deposit") || null;
  const depositGlId = depositMapping?.glAccountId || null;

  // Query all payments for the date
  const paymentWhere: Record<string, unknown> = {
    paymentDate: { gte: dayStart, lt: dayEndExclusive },
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
                          // B3 classified-writeoff GL, department-scoped.
                          // Previously modeled but not consumed by the JE
                          // generator -- see docs/domains/accounting.md gap
                          // list, "Shrinkage JE workflow."
                          shrinkageAccount: { select: { id: true, code: true, name: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          // B3: ERP-native Return records tied to this order, used to
          // classify return-shaped lines as restock vs. writeoff instead of
          // defaulting every return to restock. Empty for every imported
          // historical return (the Return table is never populated by
          // import -- docs/domains/returns.md "the dual reality").
          returns: {
            select: {
              id: true,
              lineItemId: true,
              productId: true,
              status: true,
              inspectionCondition: true,
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
    // A refund moves money OUT of the drawer, so it must reduce the cash side
    // of the journal. Two sign conventions coexist in the data and neither can
    // be assumed: imported POS refunds arrive already negative, while
    // processRefund writes a POSITIVE amount and marks isRefund. Normalising on
    // the flag makes both mean the same thing, and -Math.abs() cannot
    // double-negate a row that was already stored negative.
    //
    // Before this, a native refund was summed as cash RECEIVED — it inflated
    // the day's cash instead of relieving it, and the daily reconciliation
    // reported drift with no obvious cause.
    const rawAmount = toNum(payment.paymentAmount);
    const amount = payment.isRefund ? -Math.abs(rawAmount) : rawAmount;
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
      // Recorded fact, not inference: only processRefund sets this, and it
      // means "the order this points at was already recognized." See the
      // guard in buildJournalLines.
      reversesPaymentId: payment.originalPaymentId,
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
              productId: li.productId ?? null,
              accountGroup: li.product?.category?.accountGroup
                ? {
                    name: li.product.category.accountGroup.name,
                    salesGlId: li.product.category.accountGroup.salesAccount?.id || null,
                    cogsGlId: li.product.category.accountGroup.cogsAccount?.id || null,
                    inventoryGlId: li.product.category.accountGroup.inventoryAccount?.id || null,
                    shrinkageGlId: li.product.category.accountGroup.shrinkageAccount?.id || null,
                  }
                : null,
            })),
            // B3: hand the order's Return records through so
            // buildJournalLines can classify each return-shaped line
            // (resolveReturnBookingPath) instead of assuming restock for
            // every one of them.
            returns: payment.salesOrder.returns.map((r) => ({
              id: r.id,
              lineItemId: r.lineItemId,
              productId: r.productId,
              status: r.status,
              inspectionCondition: r.inspectionCondition,
            })),
          }
        : null,
    });
  }

  const result = buildJournalLines(mappedPayments, overShortGlId, depositGlId, journalNumber);
  warnings.push(...result.warnings);

  // A plug big enough to be a missing payment escalates out-of-band rather
  // than waiting for someone to read `warnings` on the generate response.
  // It is NOT a hard failure: the JE is created as DRAFT and never
  // auto-POSTED, and refusing to write it would deny the accountant the one
  // artifact that shows WHERE the money went missing. `JournalStatus` has no
  // "needs review" state to park it in (DRAFT | POSTED | EXPORTED), and
  // inventing one is a schema + state-machine + UI change well past the fix
  // for this symptom (CLAUDE.md rule 18).
  if (Math.abs(result.overShort) > OVER_SHORT_ALERT_THRESHOLD) {
    await reportOpsAlert({
      title: `Sales journal ${journalNumber} required a $${Math.abs(result.overShort).toFixed(2)} Over/Short plug`,
      detail:
        `${journalNumber} (${dayKey}) did not balance on its own. ` +
        `A plug of $${Math.abs(result.overShort).toFixed(2)} was posted to the Over/Short account to force it into balance, ` +
        `which almost always means a payment or a line item is missing from the day. ` +
        `The entry is DRAFT — review it before posting or exporting to QuickBooks.`,
      context: {
        journalNumber,
        journalDate: dayKey,
        overShort: result.overShort,
        threshold: OVER_SHORT_ALERT_THRESHOLD,
        paymentsConsidered: mappedPayments.length,
        storeLocation: storeLocation ?? null,
      },
    });
  }

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
        // The DATE MARKER (UTC midnight of the calendar day), not the business
        // day's opening instant -- so reading it back with UTC getters recovers
        // the same calendar date in every timezone.
        journalDate: date,
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
