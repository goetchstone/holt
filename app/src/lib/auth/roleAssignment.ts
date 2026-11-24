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

import { StaffRole, type Prisma, type PrismaClient } from "@prisma/client";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { PRIVILEGED_STAFF_ROLES, isPrivilegedStaffRole } from "@/lib/auth/adminLockout";
import { OWNER_ONLY_PERMISSIONS, getPermission } from "@/lib/auth/permissionCatalog";

/** Prisma, or the transaction a write runs in. */
type Db = PrismaClient | Prisma.TransactionClient;

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
  /** The OWNER_ONLY_PERMISSIONS keys the role holds (an Owner may grant one to any role). */
  ownerOnlyKeys: readonly string[];
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
 *
 * A role holding an owner-only key (OWNER_ONLY_PERMISSIONS) counts as the owner
 * tier here: assigning it hands the key over, and only an owner moves those
 * keys (roleEditRefusalFor). Until 2026-11-21 an Administrator could assign a
 * role the Owner had given staff.commission-pay, to anyone, themselves included.
 */
export function refusalFor(callerRole: string | null, target: TargetRole): string | null {
  if (!isAdmin(callerRole)) {
    return "Only an admin can assign roles.";
  }
  if (
    (isOwnerTier(target) || target.ownerOnlyKeys.length > 0) &&
    callerRole !== StaffRole.SUPER_ADMIN
  ) {
    return `Only an owner can assign ${target.name}.`;
  }
  return null;
}

// ── Changing how someone signs in (USE-02's third door, 2026-11-21) ──────────
//
// A member's password, sign-in email, active status, the login their row is
// linked to, and (for the owner tier) their role each decide who can sign in
// as them. Whoever changes one can become that member, so it takes what
// assigning their role takes: admins only, and a member in the owner tier only
// by an owner. The rule judges the member's CURRENT standing, read strictly
// (isOwnerTierMember), inside the write's transaction.
//
// Its limit, stated rather than hidden (rule 5): it judges the member's tier
// when the sign-in change happens. A password an Administrator set while the
// member was ordinary still works after a later promotion into the owner tier.
// Tracked in docs/domains/staff-auth.md ("Changing how someone signs in").

export type SignInChange = "password" | "sign-in email" | "active status" | "login link" | "role";

/** The member a sign-in change is judged against. */
export interface SignInSubject {
  /** The name of the role they hold, for the refusal. */
  roleName: string;
  /** Strict owner tier: the enum, the Role row, or any owner-only key it holds. */
  ownerTier: boolean;
  /** Owner tier by the enum or the Role row alone, never by a held key. */
  ownerTierByRole: boolean;
  /** An admin by either column (ADMIN or SUPER_ADMIN), or the owner tier. */
  privileged: boolean;
}

/**
 * Pure: may `callerRole` make `change` to how `member` signs in? Admins only,
 * and a member in the owner tier only by an owner. passwordRefusalFor is this
 * rule for the 'password' noun, and keeps its #136 messages.
 */
export function signInRefusalFor(
  callerRole: string | null,
  member: Pick<SignInSubject, "roleName" | "ownerTier">,
  change: SignInChange,
): string | null {
  if (!isAdmin(callerRole)) {
    return change === "password"
      ? "Only an admin can set a staff member's password."
      : `Only an admin can change a staff member's ${change}.`;
  }
  if (member.ownerTier && callerRole !== StaffRole.SUPER_ADMIN) {
    return change === "password"
      ? `Only an owner can set the password of someone who holds ${member.roleName}.`
      : `Only an owner can change the ${change} of someone who holds ${member.roleName}.`;
  }
  return null;
}

/**
 * Pure: may `callerRole` switch `member` off? Narrower than signInRefusalFor,
 * because deactivating someone only removes a sign-in: it lets nobody sign in
 * as them. Anyone who reaches the route (staff.manage) may switch off an
 * ordinary member, so a departed clerk is not left active until an admin acts;
 * an ADMIN or SUPER_ADMIN member needs an admin, and the owner tier (by the
 * enum or the Role row, NOT by a held owner-only key) needs an owner. Turning
 * someone back on is a sign-in change and takes signInRefusalFor.
 */
export function deactivationRefusalFor(
  callerRole: string | null,
  member: Pick<SignInSubject, "roleName" | "privileged" | "ownerTierByRole">,
): string | null {
  if (member.ownerTierByRole && callerRole !== StaffRole.SUPER_ADMIN) {
    return `Only an owner can deactivate someone who holds ${member.roleName}.`;
  }
  if (member.privileged && !isAdmin(callerRole)) {
    return `Only an admin can deactivate someone who holds ${member.roleName}.`;
  }
  return null;
}

interface MemberRoleFacts {
  /** The legacy StaffRole enum on the row. */
  enumRole: string;
  /** The linked Role row, else the built-in row for the enum; null if neither exists. */
  role: { key: string; name: string; grantsAllPermissions: boolean } | null;
  /** The OWNER_ONLY_PERMISSIONS keys that Role holds. */
  ownerOnlyKeysHeld: readonly string[];
}

/**
 * Pure: is this member in the owner tier, read as strictly as the two role
 * columns and OWNER_ONLY_PERMISSIONS allow? A row can say SUPER_ADMIN in the
 * enum beside a non-owner roleId (scripts/create-admin.mjs promotes the enum
 * only), and callerStaffRole reads the enum, so either column saying "owner"
 * makes them one. So does any owner-only key their Role holds.
 */
export function isOwnerTierMember(m: MemberRoleFacts): boolean {
  return (
    m.enumRole === StaffRole.SUPER_ADMIN ||
    (m.role !== null && isOwnerTier(m.role)) ||
    m.ownerOnlyKeysHeld.length > 0
  );
}

/** Pure: the subject a sign-in change is judged against, from the member's role facts. */
export function signInSubjectFor(m: MemberRoleFacts): SignInSubject {
  const ownerTierByRole =
    m.enumRole === StaffRole.SUPER_ADMIN || (m.role !== null && isOwnerTier(m.role));
  return {
    roleName: m.role?.name ?? m.enumRole,
    ownerTier: isOwnerTierMember(m),
    ownerTierByRole,
    privileged:
      ownerTierByRole || isPrivilegedStaffRole(m.enumRole) || isPrivilegedStaffRole(m.role?.key),
  };
}

/** The one way an email is stored and compared: trimmed, and blank means none. */
export function normalizeStaffEmail(email: string | null | undefined): string | null {
  return (email ?? "").trim() || null;
}

/**
 * Pure: what a PATCH body changes about how the member signs in. The email is
 * compared trimmed on both sides (exactly otherwise), so a Save that resends it
 * unchanged is no change and is never refused. Keys appear only for a change.
 */
export function signInChanges(
  current: { email: string | null; isActive: boolean },
  body: { email?: string | null; isActive?: boolean },
): { email?: string | null; active?: "deactivate" | "reactivate" } {
  const changes: { email?: string | null; active?: "deactivate" | "reactivate" } = {};
  if (body.email !== undefined) {
    const next = normalizeStaffEmail(body.email);
    if (next !== normalizeStaffEmail(current.email)) changes.email = next;
  }
  if (body.isActive !== undefined && body.isActive !== current.isActive) {
    changes.active = body.isActive ? "reactivate" : "deactivate";
  }
  return changes;
}

const ROLE_FACTS_SELECT = {
  key: true,
  name: true,
  grantsAllPermissions: true,
  permissions: {
    where: { permission: { in: [...OWNER_ONLY_PERMISSIONS] } },
    select: { permission: true },
  },
} satisfies Prisma.RoleSelect;

/** The Role row's facts for the subject, by id or by key, with its owner-only keys. */
async function roleFacts(
  db: Db,
  where: { id: number } | { key: string },
): Promise<{ role: MemberRoleFacts["role"]; ownerOnlyKeysHeld: string[] }> {
  const row = await db.role.findUnique({ where, select: ROLE_FACTS_SELECT });
  if (!row) return { role: null, ownerOnlyKeysHeld: [] };
  return {
    role: { key: row.key, name: row.name, grantsAllPermissions: row.grantsAllPermissions },
    ownerOnlyKeysHeld: row.permissions.map((p) => p.permission),
  };
}

/**
 * The member's sign-in subject, read through `db` (pass the write's
 * transaction). Their linked Role row, else the built-in row for their enum, as
 * a member never linked to a Role row still has one. Null when no such member.
 */
export async function memberSignInSubject(db: Db, memberId: number): Promise<SignInSubject | null> {
  const member = await db.staffMember.findUnique({
    where: { id: memberId },
    select: { role: true, roleId: true },
  });
  if (!member) return null;
  const facts =
    member.roleId == null
      ? await roleFacts(db, { key: member.role })
      : await roleFacts(db, { id: member.roleId });
  return signInSubjectFor({ enumRole: member.role, ...facts });
}

/** The subject a NEW member would be: judged by the role they are being given. */
export async function subjectForAssignment(
  assignment: RoleAssignment,
  db: Db = prisma,
): Promise<SignInSubject> {
  const facts =
    assignment.roleId == null
      ? await roleFacts(db, { key: assignment.role })
      : await roleFacts(db, { id: assignment.roleId });
  return signInSubjectFor({ enumRole: assignment.role, ...facts });
}

/**
 * May this session make `change` to how member `memberId` signs in? Reads the
 * caller and the member through `db`, so call it inside the write's
 * transaction, after locking the member's row. 404 when there is no member.
 */
export async function signInChangeRefusal(
  db: Db,
  session: Session,
  memberId: number,
  change: SignInChange,
): Promise<{ status: 403 | 404; error: string } | null> {
  const subject = await memberSignInSubject(db, memberId);
  if (!subject) return { status: 404, error: "Staff member not found" };
  const refusal = signInRefusalFor(await callerStaffRole(session, db), subject, change);
  return refusal ? { status: 403, error: refusal } : null;
}

/**
 * Pure: may `callerRole` set the sign-in password of a member whose role is
 * `memberRole`? Setting someone's password lets the setter sign in as them, so
 * it is the same power as giving them that role, and the same rule decides it:
 * admins only, and the owner tier only by an owner. Until 2026-11-20 the route
 * checked only staff.manage, which General Managers and People Operations hold.
 * The route itself now uses signInChangeRefusal, which reads the member's tier
 * strictly; this keeps the role-only reading for callers holding just a Role.
 */
export function passwordRefusalFor(
  callerRole: string | null,
  memberRole: Pick<TargetRole, "key" | "name" | "grantsAllPermissions">,
): string | null {
  return signInRefusalFor(
    callerRole,
    { roleName: memberRole.name, ownerTier: isOwnerTier(memberRole) },
    "password",
  );
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
async function findTarget(roleId: unknown, role: unknown, db: Db): Promise<TargetRole | null> {
  const select = {
    id: true,
    key: true,
    name: true,
    isSystem: true,
    grantsAllPermissions: true,
    permissions: ROLE_FACTS_SELECT.permissions,
  };
  let row = null;
  if (typeof roleId === "number" && Number.isInteger(roleId)) {
    row = await db.role.findUnique({ where: { id: roleId }, select });
  } else if (typeof role === "string" && role) {
    row = await db.role.findUnique({ where: { key: role }, select });
  }
  if (!row) return null;
  const { permissions, ...rest } = row;
  return { ...rest, ownerOnlyKeys: permissions.map((p) => p.permission) };
}

/** The signed-in caller's own staff role, read fresh -- never from the session. */
export async function callerStaffRole(session: Session, db: Db = prisma): Promise<string | null> {
  const userId = (session.user as { id?: string } | undefined)?.id;
  if (!userId) return null;
  const staff = await db.staffMember.findFirst({
    where: { userId, isActive: true },
    select: { role: true },
  });
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
 * `db` is the write's transaction when there is one.
 */
export async function resolveRoleAssignment(
  request: { roleId?: unknown; role?: unknown },
  session: Session,
  current?: { role: string; roleId: number | null },
  db: Db = prisma,
): Promise<AssignmentResult> {
  const target = await findTarget(request.roleId, request.role, db);
  if (!target) return { ok: false, status: 400, error: "Unknown role." };
  if (current && alreadyHolds(current, target)) return { ok: true, assignment: null };
  const refusal = refusalFor(await callerStaffRole(session, db), target);
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
