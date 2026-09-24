// /app/src/pages/api/staff/index.ts
// GET  /api/staff — list staff (active by default; ?all=true for all, ?isDesigner=true for flagged)
// POST /api/staff — create a new staff member

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import {
  DEFAULT_STAFF_ROLE,
  defaultAssignment,
  resolveRoleAssignment,
} from "@/lib/auth/roleAssignment";
import { prisma } from "@/lib/prisma";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.StaffMemberWhereInput = {};
  if (req.query.all !== "true") where.isActive = true;
  if (req.query.isDesigner === "true") where.isDesigner = true;
  const staff = await prisma.staffMember.findMany({
    where,
    orderBy: { displayName: "asc" },
    include: {
      user: { select: { email: true, name: true, image: true } },
      commissionPlan: { select: { id: true, name: true } },
      roleRef: { select: { id: true, key: true, name: true } },
    },
  });
  return res.json(staff);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { displayName, email, role, roleId, defaultStore, isDesigner } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });

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
        // Default the report-visibility flag from the role unless set explicitly.
        isDesigner:
          typeof isDesigner === "boolean" ? isDesigner : assignment.role === DEFAULT_STAFF_ROLE,
      },
      include: { user: { select: { email: true, name: true, image: true } } },
    });
    return res.status(201).json(member);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: "Email already in use by another staff member" });
    }
    throw err;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res, session);
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("staff.manage", handler);
