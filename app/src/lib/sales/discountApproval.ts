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
// Every route that can sell below list calls authorizeDiscount() before its
// transaction, and logDiscountApproval() inside it.

import type { PrismaClient } from "@prisma/client";
import type { PrismaTx } from "@/lib/inventory/allocation";
import { resolveGrantedPermissions } from "@/lib/auth/permissionResolver";
import { verifyPassword } from "@/lib/auth/password";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { catalogRetailPrice } from "@/lib/pos/cartPricing";
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
 * Each line's unit list price: a catalog product's retail price
 * (catalogRetailPrice), else the price the line was written at. A price typed
 * below retail is then a discount like any other, not a way around one.
 */
export async function catalogListUnits(
  db: PrismaTx,
  lines: readonly { productId: number | null; unitPrice: number }[],
): Promise<number[]> {
  const ids = [...new Set(lines.flatMap((l) => (l.productId == null ? [] : [l.productId])))];
  const products =
    ids.length > 0
      ? await db.product.findMany({
          where: { id: { in: ids } },
          select: { id: true, baseRetail: true },
        })
      : [];
  const retail = new Map(
    products.map((p) => [
      p.id,
      catalogRetailPrice({ baseRetail: p.baseRetail == null ? null : Number(p.baseRetail) }),
    ]),
  );
  return lines.map((l) => (l.productId == null ? null : retail.get(l.productId)) ?? l.unitPrice);
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
