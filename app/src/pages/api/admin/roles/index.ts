// /app/src/pages/api/admin/roles/index.ts
//
// GET  /api/admin/roles -> { roles, catalog, baseline }
// POST /api/admin/roles -> { role }
//
// The list half of the custom-role admin API. GET ships the permission catalog
// alongside the roles on purpose: the editor needs domains, labels, descriptions
// and the `sensitive` flag to render at all, and a UI that hardcoded them would
// silently omit every permission a later release adds — the same coupling the
// registry payload in api/admin/settings exists to remove.
//
// Gated on staff.manage, which the catalog describes as "Create staff and assign
// roles — grants power to others". Editing roles IS that capability; there is no
// weaker permission that could sensibly hold it.
//
// Validation-then-write, in the house shape (see api/admin/settings/index.ts):
// every check runs and returns its own message before Prisma is touched, so a
// half-applied role is not reachable.

import type { NextApiRequest, NextApiResponse } from "next";

import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  BASELINE_PERMISSIONS,
  PERMISSION_KEYS,
  stripBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import {
  ROLE_SELECT,
  buildCatalogPayload,
  parseOptionalDescription,
  parseOptionalRank,
  parsePermissionList,
  parseRoleName,
  toRoleDetail,
  toRoleSummary,
  validateRoleKey,
} from "@/lib/auth/roleAdmin";

export default requirePermission("staff.manage", async (req, res) => {
  if (req.method === "GET") return handleGet(res);
  if (req.method === "POST") return handlePost(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handleGet(res: NextApiResponse) {
  // Most privileged first, then alphabetical — the order an operator scans when
  // asking "who can do too much".
  const roles = await prisma.role.findMany({
    select: { ...ROLE_SELECT, _count: { select: { staff: true } } },
    orderBy: [{ rank: "desc" }, { name: "asc" }],
  });

  return res.json({
    roles: roles.map((r) => toRoleSummary(r, r._count.staff)),
    catalog: buildCatalogPayload(),
    baseline: [...BASELINE_PERMISSIONS],
  });
}

/**
 * Resolve the grants a new role starts from.
 *
 * `copyFromRoleId` is the primary creation path — clone the role that is nearly
 * right, then adjust — so an explicit `permissions` array always wins: it is
 * what the operator saw and adjusted in the editor. The source role is only
 * consulted when the caller sent no list at all.
 *
 * Cloning a WILDCARD role materialises today's whole catalog rather than
 * producing an empty role. A new role cannot itself be a wildcard (the flag is
 * not settable through this API), so copying the Owner's zero RolePermission
 * rows would hand back a role that grants nothing while claiming to be a copy
 * of the one that grants everything.
 */
async function resolveSeedPermissions(
  body: Record<string, unknown>,
): Promise<{ ok: true; value: string[] } | { ok: false; status: number; error: string }> {
  const copyFromRaw = body.copyFromRoleId;

  if (copyFromRaw !== undefined && copyFromRaw !== null) {
    if (typeof copyFromRaw !== "number" || !Number.isInteger(copyFromRaw)) {
      return { ok: false, status: 400, error: "copyFromRoleId must be a role id" };
    }
    const source = await prisma.role.findUnique({
      where: { id: copyFromRaw },
      select: { grantsAllPermissions: true, permissions: { select: { permission: true } } },
    });
    if (!source) {
      return {
        ok: false,
        status: 400,
        error: `copyFromRoleId ${copyFromRaw} does not name an existing role`,
      };
    }
    if (body.permissions === undefined) {
      const cloned = source.grantsAllPermissions
        ? [...PERMISSION_KEYS]
        : source.permissions.map((p) => p.permission);
      return { ok: true, value: [...new Set(stripBaselinePermissions(cloned))].sort() };
    }
  }

  const parsed = parsePermissionList(body.permissions);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  return { ok: true, value: parsed.value };
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const key = validateRoleKey(body.key);
  if (!key.ok) return res.status(400).json({ error: key.error });

  const name = parseRoleName(body.name);
  if (!name.ok) return res.status(400).json({ error: name.error });

  const description = parseOptionalDescription(body.description);
  if (!description.ok) return res.status(400).json({ error: description.error });

  const rank = parseOptionalRank(body.rank);
  if (!rank.ok) return res.status(400).json({ error: rank.error });

  const permissions = await resolveSeedPermissions(body);
  if (!permissions.ok) return res.status(permissions.status).json({ error: permissions.error });

  const clash = await prisma.role.findUnique({
    where: { key: key.value },
    select: { name: true },
  });
  if (clash) {
    return res
      .status(409)
      .json({ error: `A role with key ${key.value} already exists ("${clash.name}")` });
  }

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          key: key.value,
          name: name.value,
          description: description.value ?? null,
          rank: rank.value ?? 0,
          // Neither is settable through this API. A deployment's own role is not
          // a system role (the seeder must never touch it) and cannot hold the
          // wildcard — "grants every permission a future release adds" is a
          // property of the shipped Owner, not something an operator grants.
          isSystem: false,
          grantsAllPermissions: false,
        },
        select: { id: true },
      });
      if (permissions.value.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.value.map((permission) => ({ roleId: role.id, permission })),
          skipDuplicates: true,
        });
      }
      return tx.role.findUniqueOrThrow({ where: { id: role.id }, select: ROLE_SELECT });
    });
  } catch (err) {
    logError("Failed to create role", err, { key: key.value });
    return res.status(500).json({ error: "Failed to create role" });
  }

  // A new role changes the grant table (its key and rank join the anti-escalation
  // ladder immediately). Invalidate BEFORE responding — the UI's next request
  // must not be answered from a table that predates it.
  invalidateRoleGrantCache();

  return res.status(201).json({ role: toRoleDetail(created, 0) });
}
