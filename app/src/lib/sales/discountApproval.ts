// /app/src/lib/sales/discountApproval.ts
//
// GAP-06: a discount follows the store's policy, and a manager approves one
// with their PIN.
//
// How a store runs discounts is its own business (owner, 2026-10-30): some let
// everyone discount, some set a limit, some always want a manager. So:
//   - a role holding "Apply discounts" (sales.discount) may give any discount;
//   - anyone else may give up to AppSettings.discountLimitPercent of a line's
//     list price on their own. It defaults to 0, the locked-down choice: every
//     such discount needs a manager until the store says otherwise;
//   - above that, an active manager who holds the permission approves by
//     choosing their name and entering their PIN. Five wrong tries lock that
//     PIN for fifteen minutes.
//
// What counts as a discount, and how it is measured, is discountPolicyShared.ts.
// What a discount is measured from is catalogLinePolicies below: the line's list
// price, or on a line a customer's trade tier applies to, the price the tier
// entitles them to (GAP-06 part C).
// Every route that can sell below list calls authorizeDiscount() before its
// transaction, and logDiscountApproval() inside it.

import type { PrismaClient } from "@prisma/client";
import type { PrismaTx } from "@/lib/inventory/allocation";
import { resolveGrantedPermissions } from "@/lib/auth/permissionResolver";
import { verifyPassword } from "@/lib/auth/password";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { catalogRetailPrice } from "@/lib/pos/cartPricing";
import { toCents } from "@/lib/pricing/rounding";
import { entitledUnitPrice, tradeTierPercent } from "@/lib/pricing/tradeTier";
import {
  loadCustomerTradeTier,
  loadTradeSettings,
  tradeEligibleProducts,
} from "@/lib/pricing/tradeEligibility";
import { type EffectiveRetail, effectiveRetailFor, saleToday } from "@/lib/pricing/salePrice";
import {
  APPROVAL_REQUIRED,
  type ApprovalRequiredBody,
  type DiscountApprover,
  pinProblem,
} from "./discountPolicyShared";

/** The permission that lets a role discount freely, and approve. */
export const DISCOUNT_PERMISSION = "sales.discount";
/** Wrong PINs in a row before the PIN locks. */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;

export class DiscountApprovalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 423,
    /** Set when the request can go ahead with a manager's PIN. */
    readonly approvalRequired: ApprovalRequiredBody | null = null,
  ) {
    super(message);
    this.name = "DiscountApprovalError";
  }

  /** The response body a route sends. */
  get body(): { error: string } | ApprovalRequiredBody {
    return this.approvalRequired ?? { error: this.message };
  }
}

/** A caller that holds nothing beyond its gate: what a route assumes by default. */
export const NO_EXTRA_ACCESS: CallerAccess = { holds: {} };

/** What staff may discount on their own (0-100). */
export async function discountLimitPercent(db: PrismaTx): Promise<number> {
  // Single-org-per-deployment (docs/TENANCY.md): at most one AppSettings row.
  const settings = await db.appSettings.findFirst({ select: { discountLimitPercent: true } });
  return settings?.discountLimitPercent ?? 0;
}

async function holdsDiscountPermission(
  db: PrismaTx,
  staff: { role: string; roleId: number | null; isActive: boolean },
): Promise<boolean> {
  const grants = await resolveGrantedPermissions(staff, db as PrismaClient);
  return grants.includes(DISCOUNT_PERMISSION);
}

/** Who can approve: active staff holding the permission, with a PIN set. */
export async function listDiscountApprovers(db: PrismaTx): Promise<DiscountApprover[]> {
  const staff = await db.staffMember.findMany({
    where: { isActive: true, pinHash: { not: null } },
    select: { id: true, displayName: true, role: true, roleId: true, isActive: true },
    orderBy: { displayName: "asc" },
  });
  const approvers: DiscountApprover[] = [];
  for (const s of staff) {
    if (await holdsDiscountPermission(db, s)) {
      approvers.push({ id: s.id, displayName: s.displayName });
    }
  }
  return approvers;
}

export interface Approver {
  id: number;
  displayName: string;
}

/**
 * Check a manager's PIN. Runs on its own, never inside the sale's transaction:
 * a wrong try has to count even though the sale it was for is refused, or the
 * lockout would roll back with it.
 */
export async function verifyApprover(db: PrismaTx, approval: unknown): Promise<Approver> {
  const { approverId, pin } = (approval ?? {}) as { approverId?: unknown; pin?: unknown };
  if (typeof approverId !== "number" || !Number.isInteger(approverId)) {
    throw new DiscountApprovalError("Choose the manager approving this.", 400);
  }
  const pinError = pinProblem(pin);
  if (pinError) throw new DiscountApprovalError(pinError, 400);

  const approver = await db.staffMember.findUnique({
    where: { id: approverId },
    select: {
      id: true,
      displayName: true,
      role: true,
      roleId: true,
      isActive: true,
      pinHash: true,
      pinLockedUntil: true,
    },
  });
  if (!approver?.isActive || !approver.pinHash || !(await holdsDiscountPermission(db, approver))) {
    throw new DiscountApprovalError("That person can't approve discounts.", 403);
  }
  const now = new Date();
  if (approver.pinLockedUntil && approver.pinLockedUntil > now) {
    throw new DiscountApprovalError(lockedMessage(approver.pinLockedUntil), 423);
  }

  if (!verifyPassword(pin as string, approver.pinHash)) {
    const counted = await db.staffMember.update({
      where: { id: approver.id },
      data: { pinFailedAttempts: { increment: 1 } },
      select: { pinFailedAttempts: true },
    });
    if (counted.pinFailedAttempts >= PIN_MAX_ATTEMPTS) {
      const until = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
      await db.staffMember.update({
        where: { id: approver.id },
        data: { pinFailedAttempts: 0, pinLockedUntil: until },
      });
      throw new DiscountApprovalError(lockedMessage(until), 423);
    }
    throw new DiscountApprovalError("That PIN isn't right.", 403);
  }

  await db.staffMember.update({
    where: { id: approver.id },
    data: { pinFailedAttempts: 0, pinLockedUntil: null },
  });
  return { id: approver.id, displayName: approver.displayName };
}

function lockedMessage(until: Date): string {
  return `Too many wrong PINs: this PIN is locked for ${PIN_LOCK_MINUTES} minutes (until ${until.toISOString()}).`;
}

/**
 * Decide a request's discount. Null when there is none, or the seller may give
 * it alone; the approver when a manager approved it. Refused otherwise, with
 * what was asked so the screen can ask for a manager.
 */
export async function authorizeDiscount(
  db: PrismaTx,
  input: { percent: number; access: CallerAccess; approval?: unknown },
): Promise<Approver | null> {
  if (!(input.percent > 0)) return null;
  if (input.access.holds[DISCOUNT_PERMISSION]) return null;
  const limit = await discountLimitPercent(db);
  if (input.percent <= limit) return null;
  if (input.approval == null) {
    throw new DiscountApprovalError("This discount needs a manager's approval.", 403, {
      error: `A discount of ${input.percent}% needs a manager's approval (staff may give up to ${limit}%).`,
      code: APPROVAL_REQUIRED,
      percent: input.percent,
      limit,
    });
  }
  return verifyApprover(db, input.approval);
}

/**
 * How the discount policy sees one line (GAP-06). `listUnit` is what the line
 * is listed at and OrderLineItem.listPrice records: a catalog product's retail
 * today, else the price the line was written at. `baselineUnit` is what a
 * discount is measured from: the list, or on a line a customer's trade tier
 * applies to, the price that tier entitles them to (lib/pricing/tradeTier.ts,
 * DECISIONS 61). A tier is a manager-set entitlement, not a cashier's discount,
 * so a sale at the entitled price needs no PIN, and anything below it is a
 * discount like any other.
 */
export interface LinePolicy {
  listUnit: number;
  baselineUnit: number;
  /**
   * The customer's tier on this line, when it applies. The id is null only on
   * a line whose tier has since been deleted: its percent is still what it got.
   */
  trade: { tierId: number | null; percent: number } | null;
}

/** A line with nothing but a price: listed at it, and measured from it. */
export function listOnlyPolicy(listUnit: number): LinePolicy {
  return { listUnit, baselineUnit: listUnit, trade: null };
}

/**
 * Each catalog product's price today, and whether that is a sale price: the
 * scheduled-sale resolver (lib/pricing/salePrice.ts, DECISIONS 60) on the
 * store's day, read as catalogRetailPrice reads a price. The only place the
 * policy learns what a product sells for (rule 42). `today` is the store's
 * business day (saleToday) unless a caller pricing for another moment passes
 * its own.
 */
async function catalogRetailFor(
  db: PrismaTx,
  productIds: readonly number[],
  today?: string,
): Promise<Map<number, { price: number | null; onSale: boolean }>> {
  const products =
    productIds.length > 0
      ? await db.product.findMany({
          where: { id: { in: [...productIds] } },
          select: { id: true, baseRetail: true },
        })
      : [];
  const effective =
    products.length > 0
      ? await effectiveRetailFor(products, today ?? (await saleToday()), db)
      : new Map<number, EffectiveRetail>();
  return new Map(
    products.map((p) => {
      const e = effective.get(p.id);
      return [
        p.id,
        { price: catalogRetailPrice({ baseRetail: e?.price }), onSale: e?.onSale === true },
      ];
    }),
  );
}

/**
 * Each line's policy (LinePolicy), and THE one place a catalog line's list
 * and baseline are decided. A line with a catalog product is listed at that
 * product's price today (its sale price while a scheduled sale is on,
 * catalogRetailFor); when `customerId` has an active tier and the
 * product may take it (lib/pricing/tradeEligibility.ts), its baseline is the
 * entitled price. A line with no product, or a product with no price, takes
 * its `fallback`: a price typed below that is then a discount like any other,
 * not a way around one. On a sale item the tier applies only when the store's
 * tradeDiscountOnSaleItems says so, and then comes off the sale price
 * (entitledUnitPrice). Every writer that runs the policy comes through here
 * (rule 42): create-from-cart, add-line, replace-line, duplicateOrder and a
 * house call's service line.
 */
export async function catalogLinePolicies(
  db: PrismaTx,
  lines: readonly { productId: number | null; fallback: LinePolicy }[],
  opts: { customerId?: number | null; today?: string } = {},
): Promise<LinePolicy[]> {
  const ids = [...new Set(lines.flatMap((l) => (l.productId == null ? [] : [l.productId])))];
  const retail = await catalogRetailFor(db, ids, opts.today);
  const priced = lines.map((line) => {
    const today = line.productId == null ? undefined : retail.get(line.productId);
    return today?.price == null
      ? null
      : { productId: line.productId as number, listUnit: today.price, onSale: today.onSale };
  });
  const traded = await tradePolicies(
    db,
    priced.flatMap((p) => (p ? [p] : [])),
    opts.customerId,
  );
  let next = 0;
  return lines.map((line, i) => (priced[i] ? traded[next++] : line.fallback));
}

/**
 * The policy of lines listed at these prices, under the customer's trade tier
 * now. catalogLinePolicies prices a new line at the product's price today; a
 * quote changing hands keeps the list price each line recorded and asks only
 * what the new customer's tier makes of it (lib/sales/quoteTradePricing.ts).
 * `onSale` is whether that price is a sale price.
 */
export async function tradePolicies(
  db: PrismaTx,
  lines: readonly { productId: number; listUnit: number; onSale: boolean }[],
  customerId: number | null | undefined,
): Promise<LinePolicy[]> {
  const tier = lines.length > 0 ? await loadCustomerTradeTier(db, customerId) : null;
  if (!tier) return lines.map((l) => listOnlyPolicy(l.listUnit));
  const eligible = await tradeEligibleProducts(
    db,
    lines.map((l) => l.productId),
  );
  const settings = await loadTradeSettings(db);
  return lines.map((line) => {
    const entitled = entitledUnitPrice({
      effectiveRetail: line.listUnit,
      onSale: line.onSale,
      tier: { discountPercent: tier.discountPercent, isActive: true },
      vendorAllows: eligible.get(line.productId) === true,
      settings,
    });
    if (entitled.tierPercent === null || entitled.price === null) {
      return listOnlyPolicy(line.listUnit);
    }
    return {
      listUnit: line.listUnit,
      baselineUnit: entitled.price,
      trade: { tierId: tier.id, percent: entitled.tierPercent },
    };
  });
}

/** Whether each of these products sells at a sale price today (catalogRetailFor). */
export async function onSaleToday(
  db: PrismaTx,
  productIds: readonly number[],
  today?: string,
): Promise<Map<number, boolean>> {
  const retail = await catalogRetailFor(db, [...new Set(productIds)], today);
  return new Map([...retail].map(([id, r]) => [id, r.onSale]));
}

/**
 * An existing line's unit list price: the one it recorded, else (a line written
 * before list prices were kept) its own unit price now. Selling it lower than
 * that is a discount.
 */
export function existingListUnit(line: {
  listPrice: unknown;
  netPrice: unknown;
  orderedQuantity: unknown;
}): number {
  if (line.listPrice != null) return Number(line.listPrice);
  const qty = Math.abs(Number(line.orderedQuantity)) || 1;
  return Math.abs(Number(line.netPrice)) / qty;
}

/**
 * An existing line's policy, from what it recorded: its list price, and when it
 * was sold at a trade tier's price, that price as its baseline -- the tier as it
 * was then, not whatever the customer's tier is now.
 */
export function existingLinePolicy(line: {
  listPrice: unknown;
  netPrice: unknown;
  orderedQuantity: unknown;
  tradeTierId?: number | null;
  tradeDiscountPercent?: unknown;
}): LinePolicy {
  const listUnit = existingListUnit(line);
  const percent = tradeTierPercent(
    line.tradeDiscountPercent == null
      ? null
      : { discountPercent: Number(line.tradeDiscountPercent) },
  );
  if (line.listPrice == null || percent === null) return listOnlyPolicy(listUnit);
  return {
    listUnit,
    baselineUnit: toCents(listUnit * (1 - percent / 100)) / 100,
    trade: { tierId: line.tradeTierId ?? null, percent },
  };
}

/** An existing line as a policy reads it: what it recorded. */
export interface RecordedLine {
  productId: number | null;
  listPrice: unknown;
  netPrice: unknown;
  orderedQuantity: unknown;
  tradeTierId?: number | null;
  tradeDiscountPercent?: unknown;
}

/**
 * Existing lines' policies for a customer: what each line recorded
 * (existingLinePolicy), or -- where it is lower -- what that customer's tier
 * makes of the list price the line recorded. A line whose price was raised
 * above its trade price no longer records its tier, yet the customer it is sold
 * to is still entitled to it: bringing the price back down is not a discount.
 * And a quote changing hands asks what each line was measured from under the
 * customer it is leaving (lib/sales/quoteTradePricing.ts).
 */
export async function currentLinePolicies(
  db: PrismaTx,
  lines: readonly RecordedLine[],
  customerId: number | null | undefined,
): Promise<LinePolicy[]> {
  const policies = lines.map(existingLinePolicy);
  const tierable = lines.flatMap((line, i) =>
    line.productId != null && line.listPrice != null
      ? [{ i, productId: line.productId, listUnit: Number(line.listPrice) }]
      : [],
  );
  if (tierable.length === 0 || customerId == null) return policies;
  const onSale = await onSaleToday(
    db,
    tierable.map((l) => l.productId),
  );
  const tiered = await tradePolicies(
    db,
    tierable.map((l) => ({
      productId: l.productId,
      listUnit: l.listUnit,
      onSale: onSale.get(l.productId) === true,
    })),
    customerId,
  );
  tierable.forEach((l, k) => {
    if (tiered[k].baselineUnit < policies[l.i].baselineUnit - 0.005) policies[l.i] = tiered[k];
  });
  return policies;
}

/**
 * The trade columns a written line records (OrderLineItem.tradeTierId,
 * tradeDiscountPercent): set when the line got its tier -- sold, not given
 * back, at no more than the entitled price -- so a report or a later edit knows
 * why it is below list. Null otherwise.
 */
export function recordedTrade(
  policy: LinePolicy,
  line: { quantity: number; netPrice: number },
): { tradeTierId: number | null; tradeDiscountPercent: number | null } {
  const none = { tradeTierId: null, tradeDiscountPercent: null };
  if (!policy.trade || !(line.quantity > 0)) return none;
  const entitledTotal = toCents(policy.baselineUnit * line.quantity) / 100;
  if (line.netPrice > entitledTotal + 0.005) return none;
  return {
    tradeTierId: policy.trade.tierId,
    tradeDiscountPercent: policy.trade.percent,
  };
}

/** Record on the order's history who approved a discount, and how deep. */
export async function logDiscountApproval(
  tx: PrismaTx,
  input: {
    orderId: number;
    lineItemId?: number | null;
    approver: Approver;
    percent: number;
    changedBy: string | null;
  },
): Promise<void> {
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: input.orderId,
      lineItemId: input.lineItemId ?? null,
      changeType: "DISCOUNT_APPROVED",
      newValue: `${input.percent}% off approved by ${input.approver.displayName} (staff #${input.approver.id})`,
      changedBy: input.changedBy,
    },
  });
}
