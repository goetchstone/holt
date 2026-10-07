// /app/__tests__/integration/rolesPreset.integration.test.ts
//
// Real-DB coverage for the `roles` config-preset kind. The diff logic itself
// is unit-tested against an in-memory fake in __tests__/config/rolesPreset
// .test.ts; what only Postgres and the real seeder can show is here:
//
//   - grantsCustomized actually survives a reseed, so a policy edit committed
//     to git is not silently undone by the next deploy. That is a two-actor
//     property (this preset writes, lib/auth/builtInRoles.ts reads) and a fake
//     of either half would be asserting the fake.
//   - the RolePermission @@unique([roleId, permission]) constraint holds under
//     the createMany + skipDuplicates the apply path uses.
//   - invalidateRoleGrantCache() genuinely makes a revocation visible to the
//     next resolver read, rather than after the 30s TTL. This is the one that
//     matters most: a revocation that does not bite is a security bug.
//
// NOTE: this file's schema comes from `prisma db push` (jest.integration.setup
// .ts), not from `prisma migrate deploy`.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { getRoleGrantTable, invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { rolesPresetSchema, type RolesPreset } from "@/lib/config/presetSchema";
import { applyPreset } from "@/lib/config/applyPreset";

function rolesPreset(roles: unknown[]): RolesPreset {
  return rolesPresetSchema.parse({ kind: "roles", name: "roles", roles });
}

const opts = { source: "test:integration", prisma };

async function storedGrants(key: string): Promise<string[]> {
  const role = await prisma.role.findUnique({
    where: { key },
    select: { permissions: { select: { permission: true } } },
  });
  return (role?.permissions ?? []).map((p) => p.permission).sort();
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
});

describe("roles preset — a deployment's own role", () => {
  it("creates the role and exactly the grants the file lists", async () => {
    const result = await applyPreset(
      rolesPreset([
        {
          key: "FLOOR_LEAD",
          name: "Floor Lead",
          description: "Runs the floor on a shift.",
          rank: 1,
          // The baseline is stated the way the admin screen shows it, and must
          // simply not become a row.
          permissions: ["staff.self", "sales.read", "sales.write", "sales.discount"],
        },
      ]),
      opts,
    );

    expect(result.action).toBe("APPLIED");
    const role = await prisma.role.findUnique({ where: { key: "FLOOR_LEAD" } });
    expect(role).toMatchObject({
      name: "Floor Lead",
      rank: 1,
      isSystem: false,
      grantsAllPermissions: false,
    });
    expect(await storedGrants("FLOOR_LEAD")).toEqual([
      "sales.discount",
      "sales.read",
      "sales.write",
    ]);
  });

  it("is idempotent against Postgres, and still records the re-apply", async () => {
    const preset = rolesPreset([
      { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] },
    ]);

    expect((await applyPreset(preset, opts)).action).toBe("APPLIED");
    const second = await applyPreset(preset, opts);

    expect(second.action).toBe("UNCHANGED");
    expect(await prisma.rolePermission.count()).toBe(1);
    // "We applied this and it was already correct" is a fact an audit wants —
    // a re-apply that left no trace is indistinguishable from never running.
    expect(
      await prisma.configChangeLog.count({ where: { presetKind: "roles", action: "UNCHANGED" } }),
    ).toBe(1);
  });

  it("revokes a permission removed from the file", async () => {
    await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read", "sales.discount"] },
      ]),
      opts,
    );

    const result = await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts,
    );

    expect(result.changes).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect(await storedGrants("FLOOR_LEAD")).toEqual(["sales.read"]);
  });

  it("updates identity fields it owns", async () => {
    await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: [] }]),
      opts,
    );

    const result = await applyPreset(
      rolesPreset([
        {
          key: "FLOOR_LEAD",
          name: "Shift Lead",
          description: "Renamed.",
          rank: 2,
          permissions: [],
        },
      ]),
      opts,
    );

    expect(result.action).toBe("APPLIED");
    expect(result.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(await prisma.role.findUnique({ where: { key: "FLOOR_LEAD" } })).toMatchObject({
      name: "Shift Lead",
      description: "Renamed.",
      rank: 2,
    });
  });

  it("does not delete a role that leaves the file", async () => {
    await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: [] },
        { key: "NIGHT_CREW", name: "Night Crew", permissions: ["warehouse.read"] },
      ]),
      opts,
    );

    await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: [] }]),
      opts,
    );

    expect(await prisma.role.findUnique({ where: { key: "NIGHT_CREW" } })).not.toBeNull();
    expect(await storedGrants("NIGHT_CREW")).toEqual(["warehouse.read"]);
  });
});

describe("roles preset — built-in roles", () => {
  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
  });

  it("re-permissions a built-in and survives the next deploy's reseed", async () => {
    // THE property this kind exists for. Without grantsCustomized the seeder
    // reconciles DESIGNER back to the shipped definition on every deploy, and
    // a deliberate revocation committed to git silently reappears.
    const result = await applyPreset(
      rolesPreset([
        { key: "DESIGNER", name: "Designer", permissions: ["sales.read", "customer.read"] },
      ]),
      opts,
    );
    expect(result.action).toBe("APPLIED");
    expect(await storedGrants("DESIGNER")).toEqual(["customer.read", "sales.read"]);
    expect(
      await prisma.role.findUnique({
        where: { key: "DESIGNER" },
        select: { grantsCustomized: true },
      }),
    ).toEqual({ grantsCustomized: true });

    const reseed = await syncBuiltInRoles({ prisma });

    expect(reseed.grantsSkippedCustomized).toContain("DESIGNER");
    expect(await storedGrants("DESIGNER")).toEqual(["customer.read", "sales.read"]);
  });

  it("claims grants that already match, so the seeder stops owning them", async () => {
    const current = await storedGrants("DESIGNER");
    const preset = rolesPreset([{ key: "DESIGNER", name: "Designer", permissions: current }]);

    const first = await applyPreset(preset, opts);
    expect(first.action).toBe("APPLIED");
    expect(first.changes).toEqual({ created: 0, updated: 1, deleted: 0 });

    // Stable afterwards: the same file now writes nothing at all.
    expect((await applyPreset(preset, opts)).action).toBe("UNCHANGED");
    expect(await storedGrants("DESIGNER")).toEqual(current);
  });

  it("refuses to contradict a built-in's code-owned identity", async () => {
    const result = await applyPreset(
      rolesPreset([{ key: "DESIGNER", name: "Sales Associate", permissions: [] }]),
      opts,
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/reconciled from lib\/auth\/permissionCatalog\.ts/);
    // Nothing written — not the name, not the grants.
    const role = await prisma.role.findUnique({ where: { key: "DESIGNER" } });
    expect(role?.name).toBe("Designer");
    expect((await storedGrants("DESIGNER")).length).toBeGreaterThan(0);
  });

  it("refuses to narrow the wildcard role", async () => {
    const result = await applyPreset(
      rolesPreset([{ key: "SUPER_ADMIN", name: "Owner", permissions: ["sales.read"] }]),
      opts,
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/wildcard/);
    expect(await storedGrants("SUPER_ADMIN")).toEqual([]);
  });

  it("records a FAILED apply in the durable audit trail", async () => {
    await applyPreset(
      rolesPreset([{ key: "SUPER_ADMIN", name: "Owner", permissions: ["sales.read"] }]),
      opts,
    );

    const row = await prisma.configChangeLog.findFirst({
      where: { presetKind: "roles", action: "FAILED" },
    });
    expect(row).not.toBeNull();
    expect(row?.source).toBe("test:integration");
  });
});

describe("roles preset — grant cache", () => {
  it("makes a revocation visible to the next resolver read, not 30s later", async () => {
    await syncBuiltInRoles({ prisma });
    await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read", "sales.discount"] },
      ]),
      opts,
    );

    // Warm the cache so the next read would be served from it.
    const before = await getRoleGrantTable(prisma);
    expect(before.grantsByRole.FLOOR_LEAD).toEqual(
      expect.arrayContaining(["sales.read", "sales.discount"]),
    );

    await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts,
    );

    const after = await getRoleGrantTable(prisma);
    expect(after.grantsByRole.FLOOR_LEAD).toContain("sales.read");
    expect(after.grantsByRole.FLOOR_LEAD).not.toContain("sales.discount");
    // The floor is added by the resolver, never stored — so it is still here
    // even though no RolePermission row carries it.
    expect(after.grantsByRole.FLOOR_LEAD).toContain("staff.self");
  });

  it("does not invalidate on an apply that wrote nothing", async () => {
    const preset = rolesPreset([
      { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] },
    ]);
    await applyPreset(preset, opts);

    const first = await getRoleGrantTable(prisma);
    await applyPreset(preset, opts);
    // Same object identity: the cached table was neither dropped nor rebuilt.
    expect(await getRoleGrantTable(prisma)).toBe(first);
  });
});

describe("roles preset — self-lockout guard", () => {
  /** An active, signed-in staff member on the given role. Only this kind
   *  counts as a holder; a StaffMember with no userId is a name on the
   *  up-board that nobody can sign in as. */
  async function makeStaff(userId: string, roleKey: string) {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
    const role = await prisma.role.findUnique({ where: { key: roleKey } });
    await prisma.staffMember.create({
      data: {
        userId,
        displayName: userId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        role: roleKey as any,
        roleId: role?.id ?? null,
        isActive: true,
      },
    });
  }

  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
  });

  it("refuses a file that would revoke the last staff.manage grant", async () => {
    // The only signed-in person is an ADMIN, and the file takes staff.manage
    // away from ADMIN. Nobody — including whoever ran the CLI — could grant it
    // back. Same guard, same message, as the admin API's PUT.
    await makeStaff("only-admin", "ADMIN");
    const kept = (await storedGrants("ADMIN")).filter((p) => p !== "staff.manage");

    const result = await applyPreset(
      rolesPreset([{ key: "ADMIN", name: "Administrator", permissions: kept }]),
      opts,
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/no active staff member able to manage staff/);
    // Refused BEFORE the write: the grant is still there.
    expect(await storedGrants("ADMIN")).toContain("staff.manage");
  });

  it("allows it once someone else can still manage staff", async () => {
    await makeStaff("only-admin", "ADMIN");
    await makeStaff("the-owner", "SUPER_ADMIN");
    const kept = (await storedGrants("ADMIN")).filter((p) => p !== "staff.manage");

    const result = await applyPreset(
      rolesPreset([{ key: "ADMIN", name: "Administrator", permissions: kept }]),
      opts,
    );

    expect(result.action).toBe("APPLIED");
    expect(await storedGrants("ADMIN")).not.toContain("staff.manage");
  });

  it("does not block the first apply on a deployment with no staff yet", async () => {
    // Nobody to lock out is not a lockout — and applying roles before anyone
    // exists is the normal order of operations for a fresh install.
    const kept = (await storedGrants("ADMIN")).filter((p) => p !== "staff.manage");

    const result = await applyPreset(
      rolesPreset([{ key: "ADMIN", name: "Administrator", permissions: kept }]),
      opts,
    );

    expect(result.action).toBe("APPLIED");
  });
});
