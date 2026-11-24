// /app/src/pages/api/staff/[id].ts
// GET    /api/staff/[id] — fetch single staff member
// PATCH  /api/staff/[id] — update fields
// DELETE /api/staff/[id] — soft-delete (set isActive: false)
//
// Who may: the gate is staff.manage, which General Managers and People
// Operations hold as well as admins. Inside it, anything that changes how a
// member signs in -- their sign-in email, turning them back on, the login their
// row is linked to, and the role of a member in the owner tier -- takes what
// assigning their role takes (signInChangeRefusal, lib/auth/roleAssignment.ts):
// admins only, and the owner tier only by an owner. Switching someone OFF is
// narrower (deactivationRefusalFor): any staff.manage holder may switch off an
// ordinary member. Until 2026-11-21 nothing here judged the member's tier, so a
// General Manager could put their own address on the Owner's row, ask for a
// password reset and sign in as the Owner.
//
// Every PATCH and DELETE reads, checks and writes in ONE transaction, with the
// member's row locked (and, when the request can remove someone's admin
// standing, the active admin rows locked first, in id order), so a refusal is
// judged on the row the write lands on.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { resolvePlanAssignment } from "@/lib/commissionPlans";
import { requirePermission } from "@/lib/auth/requireAuth";
import {
  COMMISSION_PLAN_REFUSED,
  WITH_COMMISSION_PAY,
  canSeeCommissionPay,
  changesCommissionPlan,
} from "@/lib/auth/commissionPay";
import { auditActor, auditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getErrorCode, isWriteConflict } from "@/lib/errorCode";
import {
  LAST_ADMIN_MESSAGE,
  isPrivilegedStaffRole,
  lockActiveAdmins,
  wouldRemoveLastAdmin,
} from "@/lib/auth/adminLockout";
import {
  callerStaffRole,
  deactivationRefusalFor,
  memberSignInSubject,
  normalizeStaffEmail,
  resolveRoleAssignment,
  signInChangeRefusal,
  signInChanges,
  type RoleAssignment,
} from "@/lib/auth/roleAssignment";
import { logger } from "@/lib/logger";
import { STAFF_RECORD_SELECT } from "@/lib/staffRecord";

// Named columns only: never the password or PIN hash (lib/staffRecord.ts).
const MEMBER_SELECT = {
  ...STAFF_RECORD_SELECT,
  user: { select: { email: true, name: true, image: true } },
} as const;

const CURRENT_SELECT = {
  email: true,
  isActive: true,
  userId: true,
  role: true,
  roleId: true,
  commissionPlanId: true,
  protectionCommissionPlanId: true,
} as const satisfies Prisma.StaffMemberSelect;

type Current = Prisma.StaffMemberGetPayload<{ select: typeof CURRENT_SELECT }>;
type Tx = Prisma.TransactionClient;

const EMAIL_TAKEN = "Email already in use by another staff member";
const WRITE_CONFLICT = "Someone else changed this staff member; try again.";

/** Thrown to unwind the transaction with an HTTP answer attached. */
class RefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RefusedError";
  }
}

function refuseIf(refusal: { status: number; error: string } | null): void {
  if (refusal) throw new RefusedError(refusal.status, refusal.error);
}

/** Lock the member's row and read it; 404 when there is none. */
async function lockMember(tx: Tx, id: number): Promise<Current> {
  await tx.$queryRaw`SELECT id FROM "StaffMember" WHERE id = ${id} FOR UPDATE`;
  const current = await tx.staffMember.findUnique({ where: { id }, select: CURRENT_SELECT });
  if (!current) throw new RefusedError(404, "Not found");
  return current;
}

/** Switching someone off: the narrower rule, then the last-admin guard. */
async function checkDeactivation(tx: Tx, session: Session, id: number): Promise<void> {
  const subject = await memberSignInSubject(tx, id);
  if (!subject) throw new RefusedError(404, "Not found");
  const refusal = deactivationRefusalFor(await callerStaffRole(session, tx), subject);
  if (refusal) throw new RefusedError(403, refusal);
  if (await wouldRemoveLastAdmin(id, tx)) throw new RefusedError(409, LAST_ADMIN_MESSAGE);
}

/** A new sign-in email: an admin's change (an owner's, for the owner tier), and nobody else's address. */
async function checkEmailChange(
  tx: Tx,
  session: Session,
  id: number,
  next: string | null,
): Promise<void> {
  refuseIf(await signInChangeRefusal(tx, session, id, "sign-in email"));
  // Only after the 403, so a caller who may not change it learns nothing about
  // which addresses exist.
  if (!next) return;
  const taken = await tx.staffMember.findFirst({
    where: { id: { not: id }, email: { equals: next, mode: "insensitive" } },
    select: { id: true },
  });
  if (taken) throw new RefusedError(409, EMAIL_TAKEN);
}

/**
 * A role change: the one assignment rule, then (for a member already in the
 * owner tier) the owner-only rule, then the last-admin guard on a demotion.
 */
async function checkRoleChange(
  tx: Tx,
  session: Session,
  id: number,
  current: Current,
  request: { role?: unknown; roleId?: unknown },
): Promise<RoleAssignment | null> {
  const resolved = await resolveRoleAssignment(request, session, current, tx);
  if (!resolved.ok) throw new RefusedError(resolved.status, resolved.error);
  const assignment = resolved.assignment;
  if (!assignment) return null;
  const subject = await memberSignInSubject(tx, id);
  const change = "role";
  if (subject?.ownerTier) refuseIf(await signInChangeRefusal(tx, session, id, change));
  // Losing the admin enum -- a demotion, or a custom role, which writes
  // DESIGNER -- must not leave the installation with no admin.
  if (!isPrivilegedStaffRole(assignment.role) && (await wouldRemoveLastAdmin(id, tx))) {
    throw new RefusedError(409, LAST_ADMIN_MESSAGE);
  }
  return assignment;
}

/**
 * Link an unlinked row to the User login holding its email -- only for a
 * caller who may change the member's login link (a staff manager's Save skips
 * it silently), and only when it is safe: (1) never REPOINT an existing link,
 * and (2) never link a User that is already another active member's login.
 * Either would let someone point a benign record at the Owner's login and
 * scramble whose role resolves at sign-in.
 */
async function autoLinkUserId(
  tx: Tx,
  session: Session,
  id: number,
  current: Current,
  email: string,
): Promise<string | undefined> {
  if (current.userId) return undefined;
  if (await signInChangeRefusal(tx, session, id, "login link")) return undefined;
  const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return undefined;
  const alreadyLinked = await tx.staffMember.findFirst({
    where: { userId: user.id, isActive: true, id: { not: id } },
    select: { id: true },
  });
  if (alreadyLinked) {
    throw new RefusedError(
      409,
      "That email's login already belongs to another active staff member.",
    );
  }
  logger.info("staff record linked to a user login by email", { staffId: id, userId: user.id });
  return user.id;
}

/** Void the member's open reset links: they were sent to who the member used to be. */
async function voidOpenResetTokens(tx: Tx, id: number): Promise<void> {
  await tx.passwordResetToken.updateMany({
    where: { staffMemberId: id, usedAt: null },
    data: { usedAt: new Date() },
  });
}

type PlanField = "commissionPlanId" | "protectionCommissionPlanId";
type PlanValues = Partial<Record<PlanField, number | null>>;

/** The plans the body names, resolved (400 on an unknown one). */
async function resolvePlans(body: Record<string, unknown>): Promise<PlanValues> {
  const plans: PlanValues = {};
  for (const [field, kind] of [
    ["commissionPlanId", "MAIN"],
    ["protectionCommissionPlanId", "PROTECTION_PLAN"],
  ] as const) {
    if (body[field] === undefined) continue;
    const checked = await resolvePlanAssignment(body[field], kind);
    if (!checked.ok) throw new RefusedError(400, checked.error);
    plans[field] = checked.value;
  }
  return plans;
}

/**
 * A caller without staff.commission-pay may save the form with the plans the
 * member already has, never change them (the form sends them back as they were).
 */
function checkPlans(plans: PlanValues, current: Current, mayChangePlans: boolean): void {
  if (mayChangePlans) return;
  for (const field of ["commissionPlanId", "protectionCommissionPlanId"] as const) {
    if (changesCommissionPlan(plans[field], current[field])) {
      throw new RefusedError(403, COMMISSION_PLAN_REFUSED);
    }
  }
}

/** The sign-in fields a body may carry, in the shapes the rule reads. 400 otherwise. */
function signInFields(body: Record<string, unknown>): {
  email?: string | null;
  isActive?: boolean;
} {
  const { email, isActive } = body;
  if (email !== undefined && email !== null && typeof email !== "string") {
    throw new RefusedError(400, "email must be a string or null");
  }
  if (isActive !== undefined && typeof isActive !== "boolean") {
    throw new RefusedError(400, "isActive must be true or false");
  }
  return { email, isActive };
}

/** The non-sign-in fields a PATCH body sets, as it gives them. */
function plainFields(body: Record<string, unknown>): Prisma.StaffMemberUncheckedUpdateInput {
  const data: Prisma.StaffMemberUncheckedUpdateInput = {};
  if (body.displayName !== undefined) data.displayName = body.displayName as string;
  if (body.defaultStore !== undefined) data.defaultStore = (body.defaultStore as string) || null;
  if (body.isDesigner !== undefined) data.isDesigner = body.isDesigner as boolean;
  return data;
}

async function patchInTx(
  tx: Tx,
  id: number,
  body: Record<string, unknown>,
  session: Session,
  plans: PlanValues,
  mayChangePlans: boolean,
) {
  const fields = signInFields(body);
  const roleRequested = body.role !== undefined || body.roleId !== undefined;
  // Lock order: the admin set first, then the member (adminLockout.ts).
  if (fields.isActive === false || roleRequested) await lockActiveAdmins(tx);
  const current = await lockMember(tx, id);
  const changes = signInChanges(current, fields);

  if (changes.email !== undefined) await checkEmailChange(tx, session, id, changes.email);
  if (changes.active === "reactivate") {
    refuseIf(await signInChangeRefusal(tx, session, id, "active status"));
  }
  if (changes.active === "deactivate") await checkDeactivation(tx, session, id);
  const requested = { role: body.role, roleId: body.roleId };
  const assignment = roleRequested
    ? await checkRoleChange(tx, session, id, current, requested)
    : null;
  checkPlans(plans, current, mayChangePlans);

  const data: Prisma.StaffMemberUncheckedUpdateInput = { ...plainFields(body), ...plans };
  // An unchanged email is left out of the write, as stored.
  if (changes.email !== undefined) data.email = changes.email;
  if (changes.active) data.isActive = changes.active === "reactivate";
  if (assignment) {
    data.role = assignment.role;
    data.roleId = assignment.roleId;
  }
  const linkEmail = normalizeStaffEmail(fields.email);
  if (linkEmail) {
    const userId = await autoLinkUserId(tx, session, id, current, linkEmail);
    if (userId) data.userId = userId;
  }
  if (changes.email !== undefined || changes.active === "deactivate") {
    await voidOpenResetTokens(tx, id);
  }

  const member = await tx.staffMember.update({ where: { id }, data, select: MEMBER_SELECT });
  const accessChanges = staffAccessChanges(current, member);
  if (accessChanges.length > 0) {
    const summary = `${member.displayName}: ${accessChanges.join(", ")}`;
    await auditLog(
      "STAFF_CHANGED",
      auditActor(session),
      { summary, target: { type: "staff", id } },
      tx,
    );
  }
  return member;
}

async function deleteInTx(tx: Tx, id: number, session: Session) {
  // Soft-delete IS deactivation: same rule, same lockout risk, same lock order.
  await lockActiveAdmins(tx);
  const current = await lockMember(tx, id);
  if (current.isActive) {
    await checkDeactivation(tx, session, id);
    await voidOpenResetTokens(tx, id);
  }
  const member = await tx.staffMember.update({
    where: { id },
    data: { isActive: false },
    select: MEMBER_SELECT,
  });
  const summary = `${member.displayName}: deactivated`;
  await auditLog(
    "STAFF_CHANGED",
    auditActor(session),
    { summary, target: { type: "staff", id } },
    tx,
  );
  return member;
}

/** Run a staff write, answering its refusals and lost races in words (rule 11). */
async function answer(res: NextApiResponse, write: () => Promise<unknown>) {
  try {
    return res.json(await write());
  } catch (err: unknown) {
    if (err instanceof RefusedError) return res.status(err.status).json({ error: err.message });
    if (isWriteConflict(err)) return res.status(409).json({ error: WRITE_CONFLICT });
    if (getErrorCode(err) === "P2002") return res.status(409).json({ error: EMAIL_TAKEN });
    throw err;
  }
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    const member = await prisma.staffMember.findUnique({
      where: { id },
      select: MEMBER_SELECT,
    });
    if (!member) return res.status(404).json({ error: "Not found" });
    return res.json(member);
  }

  if (req.method === "PATCH") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mayChangePlans = canSeeCommissionPay(access);
    return answer(res, async () => {
      const plans = await resolvePlans(body);
      return prisma.$transaction((tx) => patchInTx(tx, id, body, session, plans, mayChangePlans));
    });
  }

  if (req.method === "DELETE") {
    return answer(res, () => prisma.$transaction((tx) => deleteInTx(tx, id, session)));
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("staff.manage", handler, WITH_COMMISSION_PAY);

/** What changed about what this person can get into. A name or a store isn't that. */
function staffAccessChanges(
  before: { role: string; roleId: number | null; isActive: boolean; email: string | null },
  after: { role: string; roleId: number | null; isActive: boolean; email: string | null },
): string[] {
  const changes: string[] = [];
  if (before.role !== after.role || before.roleId !== after.roleId) {
    changes.push(`role ${before.role} → ${after.role}`);
  }
  if (before.isActive !== after.isActive) {
    changes.push(after.isActive ? "reactivated" : "deactivated");
  }
  if (before.email !== after.email) changes.push("login email changed");
  return changes;
}
