// /app/src/pages/api/admin/permissions/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { NAV_ITEMS, DEFAULT_NAV_PERMISSIONS } from "@/lib/auth/navPermissions";
import { StaffRole } from "@prisma/client";

const VALID_ROLES: string[] = Object.values(StaffRole);
const VALID_NAV_ITEMS = NAV_ITEMS.map((item) => item.label);

export default requireAuthWithRole(["ADMIN"], async (req, res) => {
  if (req.method === "GET") {
    return handleGet(res);
  }
  if (req.method === "PUT") {
    return handlePut(req, res);
  }
  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handleGet(res: NextApiResponse) {
  const existing = await prisma.navPermission.findMany();

  if (existing.length === 0) {
    // Return defaults when no DB records exist
    const defaults = Object.entries(DEFAULT_NAV_PERMISSIONS).flatMap(([navItem, roles]) =>
      roles.map((role) => ({ navItem, role })),
    );
    return res.json({ permissions: defaults, isDefault: true });
  }

  return res.json({
    permissions: existing.map((p) => ({ navItem: p.navItem, role: p.role })),
    isDefault: false,
  });
}

async function handlePut(req: NextApiRequest, res: NextApiResponse) {
  const { permissions } = req.body;

  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: "permissions must be an array" });
  }

  // Validate entries
  for (const p of permissions) {
    if (!VALID_NAV_ITEMS.includes(p.navItem)) {
      return res.status(400).json({ error: `Invalid nav item: ${p.navItem}` });
    }
    if (!VALID_ROLES.includes(p.role)) {
      return res.status(400).json({ error: `Invalid role: ${p.role}` });
    }
  }

  await prisma.$transaction([
    prisma.navPermission.deleteMany(),
    prisma.navPermission.createMany({
      data: permissions.map((p: { navItem: string; role: string }) => ({
        navItem: p.navItem,
        role: p.role as StaffRole,
      })),
      skipDuplicates: true,
    }),
  ]);

  return res.json({ success: true });
}
