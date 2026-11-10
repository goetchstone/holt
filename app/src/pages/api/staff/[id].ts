// /app/src/pages/api/staff/[id].ts
// GET    /api/staff/[id] — fetch single staff member
// PATCH  /api/staff/[id] — update fields
// DELETE /api/staff/[id] — soft-delete (set isActive: false)

import type { NextApiRequest, NextApiResponse } from "next";
import { resolvePlanAssignment } from "@/lib/commissionPlans";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getErrorCode } from "@/lib/errorCode";
import {
  LAST_ADMIN_MESSAGE,
  isPrivilegedStaffRole,
  wouldRemoveLastAdmin,
} from "@/lib/auth/adminLockout";
import { resolveRoleAssignment, type RoleAssignment } from "@/lib/auth/roleAssignment";
import { logger } from "@/lib/logger";

// Staff records (including soft-delete via DELETE) are admin-only. Previously
// only the role-change branch inside PATCH checked anything -- GET, PATCH of
// non-role fields, and DELETE (deactivation) were reachable by any signed-in
// session with no role check at all.
export default requirePermission("staff.manage", async (req: NextApiRequest, res, session) => {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    const member = await prisma.staffMember.findUnique({
      where: { id },
      include: { user: { select: { email: true, name: true, image: true } } },
    });
    if (!member) return res.status(404).json({ error: "Not found" });
    return res.json(member);
  }

  if (req.method === "PATCH") {
    const {
      displayName,
      email,
      role,
      roleId,
      defaultStore,
      isActive,
      isDesigner,
      commissionPlanId,
      protectionCommissionPlanId,
    } = req.body;

    // A role change goes through the one assignment rule (lib/auth/roleAssignment.ts):
    // only an admin assigns roles, only an owner assigns the owner tier, and a
    // custom role writes the least-privileged enum. Naming the role the member
    // already has is no change, so saving a name edit is never refused.
    let assignment: RoleAssignment | null = null;
    if (role !== undefined || roleId !== undefined) {
      const current = await prisma.staffMember.findUnique({
        where: { id },
        select: { role: true, roleId: true },
      });
      if (!current) return res.status(404).json({ error: "Not found" });
      const requested = { role, roleId };
      const resolved = await resolveRoleAssignment(requested, session, current);
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
      assignment = resolved.assignment;
      // Losing the admin enum -- a demotion, or a custom role, which writes
      // DESIGNER -- must not leave the installation with no admin.
      if (
        assignment &&
        !isPrivilegedStaffRole(assignment.role) &&
        (await wouldRemoveLastAdmin(id))
      ) {
        return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
      }
    }

    // Deactivating via PATCH { isActive: false } is the same lockout risk as a
    // demotion or a delete, and used to walk straight past the guard above.
    if (isActive === false && (await wouldRemoveLastAdmin(id))) {
      return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    }

    const data: any = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email || null;
    if (assignment) {
      data.role = assignment.role;
      data.roleId = assignment.roleId;
    }
    if (defaultStore !== undefined) data.defaultStore = defaultStore || null;
    if (isActive !== undefined) data.isActive = isActive;
    if (isDesigner !== undefined) data.isDesigner = isDesigner;
    if (commissionPlanId !== undefined) {
      const planPatch = await resolvePlanAssignment(commissionPlanId, "MAIN");
      if (!planPatch.ok) return res.status(400).json({ error: planPatch.error });
      data.commissionPlanId = planPatch.value;
    }
    if (protectionCommissionPlanId !== undefined) {
      const planPatch = await resolvePlanAssignment(protectionCommissionPlanId, "PROTECTION_PLAN");
      if (!planPatch.ok) return res.status(400).json({ error: planPatch.error });
      data.protectionCommissionPlanId = planPatch.value;
    }

    // Auto-link: if email is set/changed, link this staff record to a matching
    // User login -- but only when it is safe to. Setting a staff member's email
    // to an existing User's email associates that login with this record, so two
    // guards: (1) never REPOINT an existing link (this record already has a
    // userId), and (2) never link a User that is already the login for a
    // different active staff member. Either would let a staff.manage holder
    // point a benign record at the owner's login and scramble whose role
    // resolves at sign-in. A genuine link is logged.
    if (email) {
      const current = await prisma.staffMember.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!current?.userId) {
        const user = await prisma.user.findUnique({ where: { email } });
        if (user) {
          const alreadyLinked = await prisma.staffMember.findFirst({
            where: { userId: user.id, isActive: true, id: { not: id } },
            select: { id: true },
          });
          if (alreadyLinked) {
            return res.status(409).json({
              error: "That email's login already belongs to another active staff member.",
            });
          }
          data.userId = user.id;
          logger.info("staff record linked to a user login by email", {
            staffId: id,
            userId: user.id,
          });
        }
      }
    }

    try {
      const before = await prisma.staffMember.findUnique({
        where: { id },
        select: { role: true, roleId: true, isActive: true, email: true },
      });
      const member = await prisma.staffMember.update({
        where: { id },
        data,
        include: { user: { select: { email: true, name: true, image: true } } },
      });
      const accessChanges = before ? staffAccessChanges(before, member) : [];
      if (accessChanges.length > 0) {
        await auditLog("STAFF_CHANGED", auditActor(session), {
          summary: `${member.displayName}: ${accessChanges.join(", ")}`,
          target: { type: "staff", id },
        });
      }
      return res.json(member);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "Email already in use by another staff member" });
      }
      throw err;
    }
  }

  if (req.method === "DELETE") {
    // Soft-delete IS deactivation, so it carries the same lockout risk.
    if (await wouldRemoveLastAdmin(id)) {
      return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    }
    const member = await prisma.staffMember.update({
      where: { id },
      data: { isActive: false },
    });
    await auditLog("STAFF_CHANGED", auditActor(session), {
      summary: `${member.displayName}: deactivated`,
      target: { type: "staff", id },
    });
    return res.json(member);
  }

  return res.status(405).json({ error: "Method not allowed" });
});

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
