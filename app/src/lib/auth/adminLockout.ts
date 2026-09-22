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
 */
export async function wouldRemoveLastAdmin(targetId: number): Promise<boolean> {
  const target = await prisma.staffMember.findUnique({
    where: { id: targetId },
    select: { role: true, isActive: true },
  });
  const targetActivePrivileged = !!target && target.isActive && isPrivilegedStaffRole(target.role);
  if (!targetActivePrivileged) return false;
  const otherActiveAdmins = await prisma.staffMember.count({
    where: {
      role: { in: [...PRIVILEGED_STAFF_ROLES] },
      isActive: true,
      id: { not: targetId },
    },
  });
  return removesLastAdmin({ targetActivePrivileged, otherActiveAdmins });
}

/** The one message every lockout-refusal path returns, so it reads the same. */
export const LAST_ADMIN_MESSAGE =
  "That would leave nobody who can administer this installation. Give another staff member an admin role first.";
