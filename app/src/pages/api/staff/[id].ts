// /app/src/pages/api/staff/[id].ts
// GET    /api/staff/[id] — fetch single staff member
// PATCH  /api/staff/[id] — update fields
// DELETE /api/staff/[id] — soft-delete (set isActive: false)

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { getErrorCode } from "@/lib/errorCode";

// Validate a commissionPlanId patch value: null clears the assignment, a
// number must reference an existing CommissionPlan. Returns ok:false on
// anything else (wrong type, unknown id).
async function resolveCommissionPlanPatch(
  commissionPlanId: unknown,
): Promise<{ ok: true; value: number | null } | { ok: false }> {
  if (commissionPlanId === null) return { ok: true, value: null };
  if (typeof commissionPlanId === "number" && Number.isInteger(commissionPlanId)) {
    const plan = await prisma.commissionPlan.findUnique({
      where: { id: commissionPlanId },
      select: { id: true },
    });
    if (plan) return { ok: true, value: commissionPlanId };
  }
  return { ok: false };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
    const { displayName, email, role, defaultStore, isActive, isDesigner, commissionPlanId } =
      req.body;

    // Role change restrictions
    if (role !== undefined) {
      const userId = (session.user as any)?.id;
      const callerStaff = userId
        ? await prisma.staffMember.findFirst({ where: { userId }, select: { role: true } })
        : null;
      const callerRole = callerStaff?.role || "DESIGNER";

      // Only ADMIN can assign the ADMIN role
      if ((role === "ADMIN" || role === "SUPER_ADMIN") && callerRole !== "ADMIN") {
        return res.status(403).json({ error: "Only an admin can assign the admin role" });
      }

      // Only ADMIN can change roles at all (MANAGER can view staff but not change roles)
      if (callerRole !== "ADMIN") {
        return res.status(403).json({ error: "Only an admin can change staff roles" });
      }

      // Prevent removing the last ADMIN
      const target = await prisma.staffMember.findUnique({ where: { id }, select: { role: true } });
      if ((target?.role === "ADMIN" || target?.role === "SUPER_ADMIN") && role !== "ADMIN") {
        const adminCount = await prisma.staffMember.count({
          where: { role: "ADMIN", isActive: true },
        });
        if (adminCount <= 1) {
          return res.status(400).json({ error: "Cannot remove the last admin" });
        }
      }
    }

    const data: any = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email || null;
    if (role !== undefined) data.role = role;
    if (defaultStore !== undefined) data.defaultStore = defaultStore || null;
    if (isActive !== undefined) data.isActive = isActive;
    if (isDesigner !== undefined) data.isDesigner = isDesigner;
    if (commissionPlanId !== undefined) {
      const planPatch = await resolveCommissionPlanPatch(commissionPlanId);
      if (!planPatch.ok) return res.status(400).json({ error: "Unknown commission plan" });
      data.commissionPlanId = planPatch.value;
    }

    // Auto-link: if email is set/changed, look for a matching User account
    if (email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        data.userId = user.id;
      }
    }

    try {
      const member = await prisma.staffMember.update({
        where: { id },
        data,
        include: { user: { select: { email: true, name: true, image: true } } },
      });
      return res.json(member);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: "Email already in use by another staff member" });
      }
      throw err;
    }
  }

  if (req.method === "DELETE") {
    // Soft-delete: set isActive to false
    const member = await prisma.staffMember.update({
      where: { id },
      data: { isActive: false },
    });
    return res.json(member);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
