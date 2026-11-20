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
  defaultAssignment,
  resolveRoleAssignment,
} from "@/lib/auth/roleAssignment";
import { prisma } from "@/lib/prisma";
import { resolvePlanAssignment } from "@/lib/commissionPlans";
import { STAFF_RECORD_SELECT } from "@/lib/staffRecord";

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

async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  const { displayName, email, role, roleId, defaultStore, isDesigner } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });
  // The plans picked on the form (GAP-24). These used to be dropped on create.
  const plans: { commissionPlanId?: number | null; protectionCommissionPlanId?: number | null } =
    {};
  for (const [field, kind] of [
    ["commissionPlanId", "MAIN"],
    ["protectionCommissionPlanId", "PROTECTION_PLAN"],
  ] as const) {
    if (req.body[field] === undefined) continue;
    const checked = await resolvePlanAssignment(req.body[field], kind);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    // A new member has no plan, so naming one is a change: it needs the key.
    if (!canSeeCommissionPay(access) && changesCommissionPlan(checked.value, null)) {
      return res.status(403).json({ error: COMMISSION_PLAN_REFUSED });
    }
    plans[field] = checked.value;
  }

  // Anyone with staff.manage may create a staff member; they get the default
  // role. Any other role is an assignment, and only an admin assigns roles
  // (lib/auth/roleAssignment.ts). This used to write whatever `role` said, so
  // any staff.manage holder could create an ADMIN.
  let assignment = await defaultAssignment();
  if (role || roleId !== undefined) {
    const requested = { role, roleId };
    const newMember = { role: DEFAULT_STAFF_ROLE, roleId: null };
    const resolved = await resolveRoleAssignment(requested, session, newMember);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    if (resolved.assignment) assignment = resolved.assignment;
  }
  try {
    const member = await prisma.staffMember.create({
      data: {
        displayName,
        email: email || null,
        role: assignment.role,
        roleId: assignment.roleId,
        defaultStore: defaultStore || null,
        ...plans,
        // Default the report-visibility flag from the role unless set explicitly.
        isDesigner:
          typeof isDesigner === "boolean" ? isDesigner : assignment.role === DEFAULT_STAFF_ROLE,
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
      return res.status(409).json({ error: "Email already in use by another staff member" });
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
