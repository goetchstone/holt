// /app/src/pages/api/staff/index.ts
// GET  /api/staff — list staff (active by default; ?all=true for all, ?isDesigner=true for flagged)
// POST /api/staff — create a new staff member

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import {
  COMMISSION_PLAN_REFUSED,
  WITH_COMMISSION_PAY,
  canSeeCommissionPay,
  changesCommissionPlan,
} from "@/lib/auth/commissionPay";
import { auditActor, auditLog } from "@/lib/audit";
import {
  DEFAULT_STAFF_ROLE,
  callerStaffRole,
  defaultAssignment,
  normalizeStaffEmail,
  resolveRoleAssignment,
  signInRefusalFor,
  subjectForAssignment,
  type RoleAssignment,
} from "@/lib/auth/roleAssignment";
import { prisma } from "@/lib/prisma";
import { resolvePlanAssignment } from "@/lib/commissionPlans";
import { STAFF_RECORD_SELECT } from "@/lib/staffRecord";

const EMAIL_TAKEN = "Email already in use by another staff member";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.StaffMemberWhereInput = {};
  if (req.query.all !== "true") where.isActive = true;
  if (req.query.isDesigner === "true") where.isDesigner = true;
  const staff = await prisma.staffMember.findMany({
    where,
    orderBy: { displayName: "asc" },
    // Named columns only: never the password or PIN hash (lib/staffRecord.ts).
    select: {
      ...STAFF_RECORD_SELECT,
      user: { select: { email: true, name: true, image: true } },
      commissionPlan: { select: { id: true, name: true } },
      protectionCommissionPlan: { select: { id: true, name: true } },
      roleRef: { select: { id: true, key: true, name: true } },
    },
  });
  return res.json(staff);
}

/** A step's answer: its value, or the refusal the request gets. */
type Step<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** The plans picked on the form (GAP-24). These used to be dropped on create. */
async function newMemberPlans(
  body: Record<string, unknown>,
  access: CallerAccess,
): Promise<Step<{ commissionPlanId?: number | null; protectionCommissionPlanId?: number | null }>> {
  const plans: { commissionPlanId?: number | null; protectionCommissionPlanId?: number | null } =
    {};
  for (const [field, kind] of [
    ["commissionPlanId", "MAIN"],
    ["protectionCommissionPlanId", "PROTECTION_PLAN"],
  ] as const) {
    if (body[field] === undefined) continue;
    const checked = await resolvePlanAssignment(body[field], kind);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    // A new member has no plan, so naming one is a change: it needs the key.
    if (!canSeeCommissionPay(access) && changesCommissionPlan(checked.value, null)) {
      return { ok: false, status: 403, error: COMMISSION_PLAN_REFUSED };
    }
    plans[field] = checked.value;
  }
  return { ok: true, value: plans };
}

/**
 * Anyone with staff.manage may create a staff member; they get the default
 * role. Any other role is an assignment, and only an admin assigns roles
 * (lib/auth/roleAssignment.ts). This used to write whatever `role` said, so
 * any staff.manage holder could create an ADMIN.
 */
async function newMemberAssignment(
  body: Record<string, unknown>,
  session: Session,
): Promise<Step<RoleAssignment>> {
  const { role, roleId } = body;
  if (!role && roleId === undefined) return { ok: true, value: await defaultAssignment() };
  const newMember = { role: DEFAULT_STAFF_ROLE, roleId: null };
  const requested = { role, roleId };
  const resolved = await resolveRoleAssignment(requested, session, newMember);
  if (!resolved.ok) return resolved;
  return { ok: true, value: resolved.assignment ?? (await defaultAssignment()) };
}

/**
 * A sign-in email decides who can sign in as the new member, so giving one
 * takes what changing one takes (USE-02's third door): an admin, and for a
 * member created into the owner tier, an owner. Anyone with staff.manage may
 * still add someone WITHOUT an email; an admin adds it later.
 */
async function newMemberEmail(
  email: unknown,
  assignment: RoleAssignment,
  session: Session,
): Promise<Step<string | null>> {
  if (email !== undefined && email !== null && typeof email !== "string") {
    return { ok: false, status: 400, error: "email must be a string or null" };
  }
  const signInEmail = normalizeStaffEmail(email);
  if (!signInEmail) return { ok: true, value: null };
  const refusal = signInRefusalFor(
    await callerStaffRole(session),
    await subjectForAssignment(assignment),
    "sign-in email",
  );
  if (refusal) return { ok: false, status: 403, error: refusal };
  // Only after the 403. The unique index is case-sensitive, so an address
  // someone already has in another letter case is refused here.
  const taken = await prisma.staffMember.findFirst({
    where: { email: { equals: signInEmail, mode: "insensitive" } },
    select: { id: true },
  });
  if (taken) return { ok: false, status: 409, error: EMAIL_TAKEN };
  return { ok: true, value: signInEmail };
}

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { displayName, defaultStore, isDesigner } = body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });
  const plans = await newMemberPlans(body, access);
  if (!plans.ok) return res.status(plans.status).json({ error: plans.error });
  const assignment = await newMemberAssignment(body, session);
  if (!assignment.ok) return res.status(assignment.status).json({ error: assignment.error });
  const { role, roleId } = assignment.value;
  const email = await newMemberEmail(body.email, assignment.value, session);
  if (!email.ok) return res.status(email.status).json({ error: email.error });
  try {
    const member = await prisma.staffMember.create({
      data: {
        displayName: displayName as string,
        email: email.value,
        role,
        roleId,
        defaultStore: (defaultStore as string) || null,
        ...plans.value,
        // Default the report-visibility flag from the role unless set explicitly.
        isDesigner: typeof isDesigner === "boolean" ? isDesigner : role === DEFAULT_STAFF_ROLE,
      },
      select: {
        ...STAFF_RECORD_SELECT,
        user: { select: { email: true, name: true, image: true } },
      },
    });
    await auditLog("STAFF_CHANGED", auditActor(session), {
      summary: `${member.displayName} added as ${member.role}`,
      target: { type: "staff", id: member.id },
    });
    return res.status(201).json(member);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: EMAIL_TAKEN });
    }
    throw err;
  }
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res, session, access);
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("staff.manage", handler, WITH_COMMISSION_PAY);
