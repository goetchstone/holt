// /app/src/lib/auth/roleAssignment.ts
//
// USE-02: who may give a staff member a role, and what that writes.
//
// One rule for both paths that set a role -- PATCH /api/staff/[id] and
// POST /api/staff -- so they cannot drift apart (principle 3). Until this, the
// PATCH path allowed only an enum ADMIN (which also refused SUPER_ADMIN), and
// the POST path checked nothing: any staff.manage holder could create an ADMIN.
//
// The rule, as the owner set it on 2026-09-23:
//   - only an ADMIN or SUPER_ADMIN assigns roles. Anyone with staff.manage may
//     still create a staff member, who then gets the default, DESIGNER;
//   - SUPER_ADMIN -- or any role that grants every permission -- is assigned
//     only by a SUPER_ADMIN. That is the owner tier roleDecision.ts already
//     keeps an ADMIN from impersonating; letting an ADMIN assign it would be
//     the same escalation by another door.
//
// What an assignment writes: `roleId` (the Role row the permission layer
// resolves) and the legacy `role` enum that most routes still gate on. A
// built-in role writes its own key; a custom role writes DESIGNER, the least
// privileged value (owner, 2026-09-23), so a custom role never leaves someone
// with more enum-gated access than they were meant to have -- and demoting an
// ADMIN to a custom role really does demote them.

import { Prisma, StaffRole } from "@prisma/client";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { PRIVILEGED_STAFF_ROLES } from "@/lib/auth/adminLockout";
import { OWNER_ONLY_PERMISSIONS, getPermission } from "@/lib/auth/permissionCatalog";

/** The legacy enum a custom role writes, and the role a new staff member gets. */
export const DEFAULT_STAFF_ROLE: StaffRole = StaffRole.DESIGNER;

export interface RoleAssignment {
  /** Null only for the default on a database never seeded with Role rows. */
  roleId: number | null;
  role: StaffRole;
}

/** `assignment: null` means the request names the role the member already has. */
export type AssignmentResult =
  { ok: true; assignment: RoleAssignment | null } | { ok: false; status: 400 | 403; error: string };

interface TargetRole {
  id: number;
  key: string;
  name: string;
  isSystem: boolean;
  grantsAllPermissions: boolean;
}

const STAFF_ROLE_VALUES = new Set<string>(Object.values(StaffRole));

/** The legacy enum value an assignment of `target` writes. */
export function legacyRoleFor(target: Pick<TargetRole, "key" | "isSystem">): StaffRole {
  return target.isSystem && STAFF_ROLE_VALUES.has(target.key)
    ? (target.key as StaffRole)
    : DEFAULT_STAFF_ROLE;
}

function isAdmin(callerRole: string | null): boolean {
  return !!callerRole && (PRIVILEGED_STAFF_ROLES as readonly string[]).includes(callerRole);
}

/** The owner tier: the Owner's own role, or any role that grants every permission. */
export function isOwnerTier(role: Pick<TargetRole, "key" | "grantsAllPermissions">): boolean {
  return role.grantsAllPermissions || role.key === StaffRole.SUPER_ADMIN;
}

/**
 * Pure: may a caller whose real (unimpersonated) staff role is `callerRole`
 * give someone `target`? Returns the refusal, or null.
 */
export function refusalFor(callerRole: string | null, target: TargetRole): string | null {
  if (!isAdmin(callerRole)) {
    return "Only an admin can assign roles.";
  }
  if (isOwnerTier(target) && callerRole !== StaffRole.SUPER_ADMIN) {
    return `Only an owner can assign ${target.name}.`;
  }
  return null;
}

/**
 * Pure: may `callerRole` set the sign-in password of a member whose role is
 * `memberRole`? Setting someone's password lets the setter sign in as them, so
 * it is the same power as giving them that role, and the same rule decides it:
 * admins only, and the owner tier only by an owner. Until 2026-11-20 the route
 * checked only staff.manage, which General Managers and People Operations hold.
 */
export function passwordRefusalFor(
  callerRole: string | null,
  memberRole: Pick<TargetRole, "key" | "name" | "grantsAllPermissions">,
): string | null {
  if (!isAdmin(callerRole)) return "Only an admin can set a staff member's password.";
  if (isOwnerTier(memberRole) && callerRole !== StaffRole.SUPER_ADMIN) {
    return `Only an owner can set the password of someone who holds ${memberRole.name}.`;
  }
  return null;
}

/**
 * Pure: may `callerRole` change what a role can do, given the owner-only keys
 * the change would grant or revoke? Editing a role's grants reaches everyone
 * who holds it, the editor included, so it takes what assigning roles takes
 * (admins only), and the owner tier's keys move only by an owner's hand.
 * Until 2026-11-20 the roles API checked only staff.manage, so anyone holding
 * it could add any key, admin and owner-only keys included, to their own role.
 */
export function roleEditRefusalFor(
  callerRole: string | null,
  ownerOnlyChanged: readonly string[],
): string | null {
  if (!isAdmin(callerRole)) return "Only an admin can change what a role can do.";
  if (ownerOnlyChanged.length > 0 && callerRole !== StaffRole.SUPER_ADMIN) {
    const names = ownerOnlyChanged.map((k) => `"${getPermission(k)?.label ?? k}"`).join(", ");
    return `Only an owner can grant or revoke ${names}.`;
  }
  return null;
}

/** The owner-only keys that differ between two grant lists, in catalog order. */
export function ownerOnlyKeysChanged(
  before: readonly string[],
  after: readonly string[],
): string[] {
  return OWNER_ONLY_PERMISSIONS.filter((k) => before.includes(k) !== after.includes(k));
}

/** The Role a request names: `roleId` (a number) wins over a legacy `role` key. */
async function findTarget(roleId: unknown, role: unknown): Promise<TargetRole | null> {
  const select = { id: true, key: true, name: true, isSystem: true, grantsAllPermissions: true };
  if (typeof roleId === "number" && Number.isInteger(roleId)) {
    return prisma.role.findUnique({ where: { id: roleId }, select });
  }
  if (typeof role === "string" && role)
    return prisma.role.findUnique({ where: { key: role }, select });
  return null;
}

/** A client `sessionStaffMember` can read through: the app's, or a transaction's. */
export type StaffLookupClient = Pick<Prisma.TransactionClient, "staffMember">;

/**
 * The signed-in caller's own active staff row: the one linked to the session's
 * User id, as every gate resolves it. Null when the session carries no id, or
 * no active row is linked to it.
 *
 * Never look the caller up by `StaffMember.email`. Anyone holding staff.manage
 * can write a staff member's email, so an email-keyed lookup lets them choose
 * whose row a session acts as -- until 2026-11-21 a General Manager who gave
 * the Owner's row their own session email opened tills and saw the pipeline
 * as the Owner. `__tests__/staffEmailLookupRatchet.test.ts` fails on a new one.
 */
export async function sessionStaffMember<S extends Prisma.StaffMemberSelect>(
  session: Session | null | undefined,
  select: S,
  db: StaffLookupClient = prisma,
): Promise<Prisma.StaffMemberGetPayload<{ select: S }> | null> {
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return null;
  const staff = await db.staffMember.findFirst({ where: { userId, isActive: true }, select });
  return staff as Prisma.StaffMemberGetPayload<{ select: S }> | null;
}

/** The signed-in caller's own staff role, read fresh -- never from the session. */
export async function callerStaffRole(session: Session): Promise<string | null> {
  const staff = await sessionStaffMember(session, { role: true });
  return staff?.role ?? null;
}

/** Does the member already hold `target`? Linked by roleId, else by the enum key. */
function alreadyHolds(current: { role: string; roleId: number | null }, target: TargetRole) {
  return current.roleId != null ? current.roleId === target.id : current.role === target.key;
}

/**
 * Resolve and authorize a requested role. Callers pass the request's `roleId`
 * and/or legacy `role`; at least one must be present (check before calling).
 * `current` is the member being edited: naming the role they already hold is
 * no assignment at all, so a non-admin saving a name change is not refused.
 */
export async function resolveRoleAssignment(
  request: { roleId?: unknown; role?: unknown },
  session: Session,
  current?: { role: string; roleId: number | null },
): Promise<AssignmentResult> {
  const target = await findTarget(request.roleId, request.role);
  if (!target) return { ok: false, status: 400, error: "Unknown role." };
  if (current && alreadyHolds(current, target)) return { ok: true, assignment: null };
  const refusal = refusalFor(await callerStaffRole(session), target);
  if (refusal) return { ok: false, status: 403, error: refusal };
  return { ok: true, assignment: { roleId: target.id, role: legacyRoleFor(target) } };
}

/** The default assignment for a new staff member: the DESIGNER role row. */
export async function defaultAssignment(): Promise<RoleAssignment> {
  const row = await prisma.role.findUnique({
    where: { key: DEFAULT_STAFF_ROLE },
    select: { id: true },
  });
  // A database never seeded with roles has no row; the enum alone then decides,
  // exactly as for every staff member created before roleId existed.
  return { roleId: row?.id ?? null, role: DEFAULT_STAFF_ROLE };
}
