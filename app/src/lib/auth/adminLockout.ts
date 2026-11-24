// /app/src/lib/auth/adminLockout.ts
//
// SEC-03: an installation must never be left with nobody who can administer it.
//
// The last-admin protection used to live only in the role-change branch of
// PATCH /api/staff/[id] -- so demoting the last admin was refused, but
// DELETE (soft-deactivate) and PATCH { isActive: false } walked straight past
// it and could deactivate the last admin, locking the owner out of their own
// installation. This centralises the check so all three paths share it.
//
// "Admin" here is the ADMIN or SUPER_ADMIN (Owner) StaffRole. The predicate is
// pure and unit-tested; wouldRemoveLastAdmin does the two reads and applies it.

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** StaffRoles that can administer the installation. */
export const PRIVILEGED_STAFF_ROLES = ["ADMIN", "SUPER_ADMIN"] as const;

export function isPrivilegedStaffRole(role: string | null | undefined): boolean {
  return !!role && (PRIVILEGED_STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Pure decision: does removing this target's admin standing (by demotion,
 * deactivation, or delete) leave nobody? True only when the target is itself an
 * active admin AND no OTHER active admin remains.
 */
export function removesLastAdmin(input: {
  targetActivePrivileged: boolean;
  otherActiveAdmins: number;
}): boolean {
  return input.targetActivePrivileged && input.otherActiveAdmins === 0;
}

/**
 * Would demoting, deactivating, or deleting this staff member leave the
 * installation with no active admin? Reads the target's current role/active
 * state and counts the other active admins. Applies to all three mutations
 * because in each the target loses its admin standing.
 *
 * Only LINKED admins count (userId set): an admin row nobody has signed in as
 * cannot administer anything. Until 2026-11-21 an unlinked admin row counted,
 * while the bootstrap safeguard (countPrivilegedStaff in permissionResolver.ts)
 * counts only linked SUPER_ADMIN/ADMIN/MANAGER rows. With one unlinked admin
 * present, deactivating every linked one passed this guard and drove that
 * count to zero, which reopened the bootstrap window: every gate allowed, and
 * any OAuth identity could sign in. Counting the same way keeps one linked
 * admin, so a staff edit can never zero it.
 *
 * Pass the write's transaction as `db`, after locking the active admin rows
 * (lockActiveAdmins), so two concurrent deactivations cannot both pass.
 */
export async function wouldRemoveLastAdmin(
  targetId: number,
  db: PrismaClient | Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const target = await db.staffMember.findUnique({
    where: { id: targetId },
    select: { role: true, isActive: true },
  });
  const targetActivePrivileged = !!target && target.isActive && isPrivilegedStaffRole(target.role);
  if (!targetActivePrivileged) return false;
  const otherActiveAdmins = await db.staffMember.count({
    where: {
      role: { in: [...PRIVILEGED_STAFF_ROLES] },
      isActive: true,
      userId: { not: null },
      id: { not: targetId },
    },
  });
  return removesLastAdmin({ targetActivePrivileged, otherActiveAdmins });
}

/**
 * Lock the active ADMIN/SUPER_ADMIN rows, in id order, inside a transaction
 * that may remove someone's admin standing. Take it FIRST, before the target's
 * own row lock: every path that locks more than one staff row then locks in
 * the same order, so two concurrent deactivations queue instead of deadlocking.
 */
export async function lockActiveAdmins(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM "StaffMember"
    WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND "isActive"
    ORDER BY id FOR UPDATE`;
}

/** The one message every lockout-refusal path returns, so it reads the same. */
export const LAST_ADMIN_MESSAGE =
  "That would leave nobody who can administer this installation. Give another staff member an admin role first.";
