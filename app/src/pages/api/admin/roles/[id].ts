// /app/src/pages/api/admin/roles/[id].ts
//
// GET    /api/admin/roles/[id]                          -> { role }
// PUT    /api/admin/roles/[id]                          -> { role }
// DELETE /api/admin/roles/[id]?reassignToRoleId=N       -> { ok, reassigned }
//
// The write half. Everything a customer could use to break their own install
// lives here, so the refusals are the interesting part, not the writes:
//
//   - a built-in role is never deletable. A deployment that could delete ADMIN
//     could lock itself out of its own installation, and no support path gets it
//     back without a psql session.
//   - a role with staff on it is never deletable without somewhere for them to
//     go. StaffMember.roleId is an OPTIONAL relation with no onDelete clause,
//     so Prisma's default is SET NULL: deleting the role would quietly drop
//     every holder back to the StaffRole enum fallback, which is a permission
//     change nobody asked for and nobody would see.
//   - key, isSystem and grantsAllPermissions are not editable on any role. The
//     first two are identity the seeder reconciles against; the third is the
//     mechanism the permission check short-circuits on.
//   - and the one that matters most: neither PUT nor DELETE may leave zero
//     active, user-linked staff holding staff.manage. That is the last
//     administrator removing their own ability to administer, and it is exactly
//     the mistake a permissions editor makes easy for the first time.
//
// Those refusals are 409, not 400. The request is well-formed; the DEPLOYMENT'S
// STATE makes it unsafe, and the UI shows `error` verbatim so the operator reads
// what would be lost rather than "invalid input".
//
// Both guards run INSIDE the same transaction as the write they guard, so the
// count they refuse on is the count the write is applied to.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";

import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import type { RoleGrantRow } from "@/lib/auth/permissionResolver";
import {
  LOCKOUT_PERMISSION,
  ROLE_SELECT,
  type StaffRoleLink,
  countStaffHolding,
  lockoutMessage,
  parseOptionalDescription,
  parseOptionalRank,
  parsePermissionList,
  parseRoleName,
  toRoleDetail,
  withPermissionsReplaced,
  withRoleRemoved,
  withStaffReassigned,
} from "@/lib/auth/roleAdmin";

/** Thrown to unwind an interactive transaction with an HTTP answer attached. */
class RefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RefusedError";
  }
}

export default requirePermission("staff.manage", async (req, res) => {
  const id = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid role id" });
  }
  if (req.method === "GET") return handleGet(id, res);
  if (req.method === "PUT") return handlePut(id, req, res);
  if (req.method === "DELETE") return handleDelete(id, req, res);
  res.setHeader("Allow", "GET, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
});

// ---------------------------------------------------------------------------
// The shared lockout guard
// ---------------------------------------------------------------------------

/**
 * Everything countStaffHolding needs, read inside the caller's transaction.
 *
 * Only ACTIVE, USER-LINKED staff count as holders. isActive is part of the
 * authorization decision everywhere else (permissionResolver reads it per
 * request), and a StaffMember with no userId is a name on the up-board that
 * nobody can sign in as — counting either would let the guard pass while the
 * deployment is, in fact, locked out.
 *
 * Sequential rather than Promise.all: integration tests run with
 * connection_limit=1 and an interactive transaction owns that one connection.
 */
async function loadLockoutState(
  tx: Prisma.TransactionClient,
): Promise<{ staff: StaffRoleLink[]; roles: RoleGrantRow[] }> {
  const staff = await tx.staffMember.findMany({
    where: { isActive: true, userId: { not: null } },
    select: { role: true, roleId: true },
  });
  const roles = await tx.role.findMany({
    select: {
      id: true,
      key: true,
      rank: true,
      grantsAllPermissions: true,
      permissions: { select: { permission: true } },
    },
  });
  return { staff, roles };
}

/**
 * THE self-lockout guard. One function, called by PUT and by DELETE (CLAUDE.md
 * rule 42 — a guard on one mutation path and not the other is no guard at all).
 * Callers pass the state they are ABOUT to write; this refuses if nobody would
 * be left holding staff.manage.
 */
function assertHolderSurvives(
  action: string,
  staff: readonly StaffRoleLink[],
  roles: readonly RoleGrantRow[],
): void {
  if (countStaffHolding(LOCKOUT_PERMISSION, staff, roles) === 0) {
    throw new RefusedError(409, lockoutMessage(action));
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

async function handleGet(id: number, res: NextApiResponse) {
  const role = await prisma.role.findUnique({
    where: { id },
    select: { ...ROLE_SELECT, _count: { select: { staff: true } } },
  });
  if (!role) return res.status(404).json({ error: "Role not found" });
  return res.json({ role: toRoleDetail(role, role._count.staff) });
}

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------

/**
 * key / isSystem / grantsAllPermissions are not editable. A client that echoes
 * back the value it was given is fine — the admin editor round-trips a
 * RoleDetail — but one that tries to CHANGE them is told which field and why,
 * rather than having the attempt silently ignored.
 */
function rejectImmutableChanges(
  body: Record<string, unknown>,
  existing: { key: string; isSystem: boolean; grantsAllPermissions: boolean },
): string | null {
  const attempts: [string, unknown, unknown, string][] = [
    ["key", body.key, existing.key, "a role key is persisted in config presets and staff links"],
    [
      "isSystem",
      body.isSystem,
      existing.isSystem,
      "whether a role ships with Holt is decided by the built-in catalog, not by an edit",
    ],
    [
      "grantsAllPermissions",
      body.grantsAllPermissions,
      existing.grantsAllPermissions,
      "the wildcard covers permissions that do not exist yet; it is not grantable per deployment",
    ],
  ];
  for (const [field, sent, current, why] of attempts) {
    if (sent === undefined || sent === current) continue;
    return `${field} cannot be changed — ${why}.`;
  }
  return null;
}

async function handlePut(id: number, req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const existing = await prisma.role.findUnique({
    where: { id },
    select: { ...ROLE_SELECT, _count: { select: { staff: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Role not found" });

  const immutable = rejectImmutableChanges(body, existing);
  if (immutable) return res.status(400).json({ error: immutable });

  const name = body.name === undefined ? null : parseRoleName(body.name);
  if (name && !name.ok) return res.status(400).json({ error: name.error });

  const description = parseOptionalDescription(body.description);
  if (!description.ok) return res.status(400).json({ error: description.error });

  const rank = parseOptionalRank(body.rank);
  if (!rank.ok) return res.status(400).json({ error: rank.error });

  let nextPermissions: string[] | undefined;
  if (body.permissions !== undefined) {
    // Writing RolePermission rows for a wildcard role would be a lie the admin
    // UI then redraws: the check short-circuits on grantsAllPermissions and
    // never reads the rows, so an operator who "revoked" a refund would watch
    // the checkbox clear and the refund still succeed.
    if (existing.grantsAllPermissions) {
      return res.status(409).json({
        error:
          `${existing.name} holds every permission through the wildcard flag, including ` +
          "ones added by future releases. Its permission list is not editable, and the " +
          "flag itself cannot be changed here. Create a role of your own instead.",
      });
    }
    const parsed = parsePermissionList(body.permissions);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    nextPermissions = parsed.value;
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      if (nextPermissions !== undefined) {
        const state = await loadLockoutState(tx);
        assertHolderSurvives(
          `Saving ${existing.name}`,
          state.staff,
          withPermissionsReplaced(state.roles, id, nextPermissions),
        );
      }

      // Re-read inside the transaction rather than diffing against the copy
      // fetched for validation. Two operators saving the same role seconds apart
      // would otherwise diff against a list that is already stale, and the
      // second save would delete grants it never saw.
      const current = (
        await tx.rolePermission.findMany({ where: { roleId: id }, select: { permission: true } })
      ).map((p) => p.permission);
      const changed =
        nextPermissions !== undefined &&
        (current.length !== nextPermissions.length ||
          !nextPermissions.every((p) => current.includes(p)));

      await tx.role.update({
        where: { id },
        data: {
          ...(name && name.ok ? { name: name.value } : {}),
          ...(description.value !== undefined ? { description: description.value } : {}),
          ...(rank.value !== undefined ? { rank: rank.value } : {}),
          // The deploy-time seeder reconciles a built-in role's grants back to
          // the shipped definition on every boot UNLESS this flag says the
          // deployment owns them. Without it, tonight's deploy silently undoes
          // this edit. Only a real change flips it — a no-op save should not
          // opt a deployment out of receiving permissions added by later
          // releases (see Role.grantsCustomized in schema.prisma).
          ...(existing.isSystem && changed ? { grantsCustomized: true } : {}),
        },
      });

      if (nextPermissions !== undefined && changed) {
        // Diffed by id rather than `deleteMany({ permission: { notIn } })`:
        // an empty notIn matches every row in Prisma, which would wipe the
        // grants of any role saved with an empty list plus whatever the
        // createMany then failed to restore. Same shape as builtInRoles.ts.
        const want = new Set(nextPermissions);
        const toRemove = current.filter((p) => !want.has(p));
        const toAdd = nextPermissions.filter((p) => !current.includes(p));
        if (toRemove.length > 0) {
          await tx.rolePermission.deleteMany({
            where: { roleId: id, permission: { in: toRemove } },
          });
        }
        if (toAdd.length > 0) {
          await tx.rolePermission.createMany({
            data: toAdd.map((permission) => ({ roleId: id, permission })),
            skipDuplicates: true,
          });
        }
      }

      return tx.role.findUniqueOrThrow({
        where: { id },
        select: { ...ROLE_SELECT, _count: { select: { staff: true } } },
      });
    });
  } catch (err) {
    if (err instanceof RefusedError) return res.status(err.status).json({ error: err.message });
    logError("Failed to update role", err, { roleId: id });
    return res.status(500).json({ error: "Failed to update role" });
  }

  // A revocation that takes up to ROLE_GRANT_CACHE_TTL_MS to bite is a security
  // bug, not an inconvenience. Invalidate before the response is written.
  invalidateRoleGrantCache();

  return res.json({ role: toRoleDetail(updated, updated._count.staff) });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

/** `?reassignToRoleId=N`. Absent is legal; a non-numeric value is not. */
function parseReassignTarget(raw: unknown): { ok: true; value: number | null } | { error: string } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return { ok: true, value: null };
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: "reassignToRoleId must be a role id" };
  }
  return { ok: true, value: parsed };
}

async function handleDelete(id: number, req: NextApiRequest, res: NextApiResponse) {
  const target = parseReassignTarget(req.query.reassignToRoleId);
  if ("error" in target) return res.status(400).json({ error: target.error });

  let reassigned = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { id },
        select: { name: true, isSystem: true, _count: { select: { staff: true } } },
      });
      if (!role) throw new RefusedError(404, "Role not found");

      if (role.isSystem) {
        throw new RefusedError(
          409,
          `${role.name} is a built-in role that ships with Holt and cannot be deleted. ` +
            "Deleting one would leave a deployment unable to reseed itself, and the " +
            "permission check falls back to these keys for any staff member whose role " +
            "link is missing. Edit its permissions instead, or create a role of your own.",
        );
      }

      // Every linked staff member, active or not: an inactive one is a
      // reactivation away from silently falling back to the StaffRole enum if
      // the role vanished from under them.
      const staffOnRole = role._count.staff;
      if (staffOnRole > 0) {
        if (target.value === null) {
          throw new RefusedError(
            409,
            `${role.name} still has ${staffOnRole} staff member${staffOnRole === 1 ? "" : "s"} ` +
              "assigned. Name a role to move them to (reassignToRoleId) — deleting the role " +
              "underneath them would drop them to their legacy role without telling anyone.",
          );
        }
        if (target.value === id) {
          throw new RefusedError(409, "reassignToRoleId must name a different role");
        }
        const destination = await tx.role.findUnique({
          where: { id: target.value },
          select: { id: true },
        });
        if (!destination) {
          throw new RefusedError(
            409,
            `reassignToRoleId ${target.value} does not name an existing role`,
          );
        }
      }

      const state = await loadLockoutState(tx);
      assertHolderSurvives(
        `Deleting ${role.name}`,
        withStaffReassigned(state.staff, id, staffOnRole > 0 ? target.value : null),
        withRoleRemoved(state.roles, id),
      );

      if (staffOnRole > 0) {
        const moved = await tx.staffMember.updateMany({
          where: { roleId: id },
          data: { roleId: target.value },
        });
        reassigned = moved.count;
      }

      // RolePermission cascades on the FK; only the Role row is deleted here.
      await tx.role.delete({ where: { id } });
    });
  } catch (err) {
    if (err instanceof RefusedError) return res.status(err.status).json({ error: err.message });
    logError("Failed to delete role", err, { roleId: id });
    return res.status(500).json({ error: "Failed to delete role" });
  }

  invalidateRoleGrantCache();

  return res.json({ ok: true, reassigned });
}
