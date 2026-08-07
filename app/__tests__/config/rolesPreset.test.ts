// /app/__tests__/config/rolesPreset.test.ts
//
// The `roles` config-preset kind: schema validation (pure) and the apply
// diff (against a small in-memory fake, dependency-injected through
// opts.prisma exactly as __tests__/config/applyPreset.test.ts does for the
// other two kinds — the shared Prisma module is never replaced, so this file
// is not a placeholder test).
//
// Two properties carry the file. First, that a permission typo dies at PARSE
// time naming the key: a preset is reviewed in a diff and applied unattended,
// and a key that merely failed to match would sit in the database looking like
// a grant while authorizing nothing. Second, rule 63 — a second apply of an
// unchanged file writes nothing, and a permission deleted from the file is
// deleted from the database.
//
// Real-database coverage (the built-in seeder's reaction to grantsCustomized,
// the (roleId, permission) unique constraint, the grant cache actually
// re-reading) is in __tests__/integration/rolesPreset.integration.test.ts.

// Only the cache-invalidation call is replaced — asserting it happens is the
// point of one test below. Everything else stays real, because the shared
// lockout guard (lib/auth/roleAdmin.ts) builds its grant table with this
// module's buildRoleGrantTable and must keep doing so here.
jest.mock("@/lib/auth/permissionResolver", () => ({
  ...jest.requireActual("@/lib/auth/permissionResolver"),
  __esModule: true,
  invalidateRoleGrantCache: jest.fn(),
}));

import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import {
  grantablePermissions,
  parsePresetBundle,
  rolesPresetSchema,
  type RolesPreset,
} from "@/lib/config/presetSchema";
import { parsePresetText, serializePresetBundle } from "@/lib/config/presetSerialize";
import { applyPreset } from "@/lib/config/applyPreset";

const invalidateMock = invalidateRoleGrantCache as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rolesPreset(roles: unknown[], overrides: Record<string, unknown> = {}): RolesPreset {
  return rolesPresetSchema.parse({
    kind: "roles",
    name: "roles",
    roles,
    ...overrides,
  });
}

function expectFailure(result: { ok: boolean; errors?: string[] }): string {
  if (result.ok) throw new Error("expected failure");
  return (result.errors ?? []).join(" ");
}

// ---------------------------------------------------------------------------
// In-memory fake Prisma client
// ---------------------------------------------------------------------------
//
// Real arrays, not canned returns, so two successive applyPreset() calls
// against one fake see each other's writes the way a database would — which
// is the only way the idempotency and revocation cases below mean anything.

interface FakeRole {
  id: number;
  key: string;
  name: string;
  description: string | null;
  rank: number;
  isSystem: boolean;
  grantsAllPermissions: boolean;
  grantsCustomized: boolean;
}
interface FakeGrant {
  id: number;
  roleId: number;
  permission: string;
}

type RoleSeed = Partial<FakeRole> & { key: string; permissions?: string[] };

interface RoleWithPermissions extends FakeRole {
  permissions: Array<{ id: number; permission: string }>;
}

// Explicitly typed rather than inferred from the object literal, because
// $transaction hands the callback the very same fake — a self-reference TS
// cannot infer through. Same reason (and same shape of comment) as the FakeDb
// in __tests__/config/applyPreset.test.ts.
interface FakeDb {
  role: {
    findMany: jest.Mock<Promise<RoleWithPermissions[]>, [{ where?: { key?: { in?: string[] } } }?]>;
    upsert: jest.Mock<
      Promise<{ id: number }>,
      [{ where: { key: string }; create: Omit<FakeRole, "id">; update: Partial<FakeRole> }]
    >;
    update: jest.Mock<Promise<FakeRole>, [{ where: { id: number }; data: Partial<FakeRole> }]>;
  };
  rolePermission: {
    deleteMany: jest.Mock<Promise<{ count: number }>, [{ where: { id: { in: number[] } } }]>;
    createMany: jest.Mock<
      Promise<{ count: number }>,
      [{ data: Array<{ roleId: number; permission: string }>; skipDuplicates?: boolean }]
    >;
  };
  // Read by the self-lockout guard (refuseRolesLockout), which asks
  // countStaffHolding() — the same function the admin API's PUT and DELETE
  // ask — whether anyone would still hold staff.manage after this apply.
  staffMember: {
    findMany: jest.Mock<Promise<StaffLink[]>, [{ where: unknown; select: unknown }]>;
  };
  configChangeLog: {
    create: jest.Mock<Promise<Record<string, unknown>>, [{ data: Record<string, unknown> }]>;
  };
  $transaction: jest.Mock<Promise<unknown>, [(tx: FakeDb) => Promise<unknown>, unknown?]>;
}

/** Active, user-linked staff — the only kind the lockout guard counts. */
interface StaffLink {
  role: string;
  roleId: number | null;
}

function createFakeDb(seed: RoleSeed[] = [], staff: StaffLink[] = []) {
  let nextRoleId = 1;
  let nextGrantId = 1;
  let nextLogId = 1;

  const roles: FakeRole[] = [];
  const grants: FakeGrant[] = [];
  const changeLogs: Array<Record<string, unknown>> = [];

  for (const s of seed) {
    const row: FakeRole = {
      id: nextRoleId++,
      key: s.key,
      name: s.name ?? s.key,
      description: s.description ?? null,
      rank: s.rank ?? 0,
      isSystem: s.isSystem ?? false,
      grantsAllPermissions: s.grantsAllPermissions ?? false,
      grantsCustomized: s.grantsCustomized ?? false,
    };
    roles.push(row);
    for (const permission of s.permissions ?? []) {
      grants.push({ id: nextGrantId++, roleId: row.id, permission });
    }
  }

  const withPermissions = (row: FakeRole): RoleWithPermissions => ({
    ...row,
    permissions: grants
      .filter((g) => g.roleId === row.id)
      .map((g) => ({ id: g.id, permission: g.permission })),
  });

  const db: FakeDb = {
    role: {
      findMany: jest.fn(async (args) => {
        const keys = args?.where?.key?.in;
        return roles.filter((r) => !keys || keys.includes(r.key)).map(withPermissions);
      }),
      // Mirrors real Prisma upsert on the @unique key: find-by-key, update in
      // place if present, otherwise create.
      upsert: jest.fn(async ({ where, create, update }) => {
        const found = roles.find((r) => r.key === where.key);
        if (found) {
          Object.assign(found, update);
          return { id: found.id };
        }
        const row: FakeRole = { id: nextRoleId++, ...create };
        roles.push(row);
        return { id: row.id };
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = roles.find((r) => r.id === where.id);
        if (!row) throw new Error(`Role ${where.id} not found`);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    rolePermission: {
      deleteMany: jest.fn(async ({ where }) => {
        const ids = new Set(where.id.in);
        const before = grants.length;
        for (let i = grants.length - 1; i >= 0; i--) {
          if (ids.has(grants[i].id)) grants.splice(i, 1);
        }
        return { count: before - grants.length };
      }),
      createMany: jest.fn(async ({ data }) => {
        let count = 0;
        for (const row of data) {
          // skipDuplicates, backed by the real @@unique([roleId, permission]).
          if (grants.some((g) => g.roleId === row.roleId && g.permission === row.permission)) {
            continue;
          }
          grants.push({ id: nextGrantId++, ...row });
          count++;
        }
        return { count };
      }),
    },
    staffMember: {
      findMany: jest.fn(async (_args) => staff.map((s) => ({ ...s }))),
    },
    configChangeLog: {
      create: jest.fn(async ({ data }) => {
        const row = { id: nextLogId++, created: new Date(), ...data };
        changeLogs.push(row);
        return row;
      }),
    },
    $transaction: jest.fn(async (fn) => fn(db)),
  };

  const grantsOf = (key: string) =>
    grants
      .filter((g) => g.roleId === roles.find((r) => r.key === key)?.id)
      .map((g) => g.permission)
      .sort();

  return { db, roles, grants, changeLogs, grantsOf };
}

function opts(db: FakeDb, extra: Record<string, unknown> = {}) {
  return { source: "test", prisma: db as never, ...extra };
}

beforeEach(() => {
  invalidateMock.mockClear();
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("roles preset schema", () => {
  it("accepts a well-formed preset", () => {
    const result = parsePresetBundle({
      kind: "roles",
      name: "roles",
      roles: [{ key: "FLOOR_LEAD", name: "Floor Lead", rank: 1, permissions: ["sales.read"] }],
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    const preset = result.bundle.presets[0];
    if (preset.kind !== "roles") throw new Error("narrowing");
    expect(preset.roles[0].key).toBe("FLOOR_LEAD");
  });

  it("refuses an unknown permission key at parse time, naming it", () => {
    // The headline rule. A preset is reviewed in a diff and applied
    // unattended; a typo must fail in the review, not silently store a grant
    // of nothing that the admin UI then renders as a grant of something.
    const errors = expectFailure(
      parsePresetBundle({
        kind: "roles",
        name: "roles",
        roles: [{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.discont"] }],
      }),
    );
    expect(errors).toMatch(/unknown permission "sales\.discont"/);
    // …and points at the domain the author was aiming at, which is where the
    // typo almost always is.
    expect(errors).toMatch(/sales\.discount/);
    expect(errors).toMatch(/roles\.0\.permissions\.0/);
  });

  it("refuses grantsAllPermissions outright rather than stripping it", () => {
    // zod drops unknown keys, so if this were not declared the line would
    // vanish silently and the author would believe they had granted it.
    const errors = expectFailure(
      parsePresetBundle({
        kind: "roles",
        name: "roles",
        roles: [
          { key: "SUPERUSER", name: "Superuser", permissions: [], grantsAllPermissions: true },
        ],
      }),
    );
    expect(errors).toMatch(/must not be able to mint a superuser/);
  });

  it("refuses isSystem for the same reason", () => {
    const errors = expectFailure(
      parsePresetBundle({
        kind: "roles",
        name: "roles",
        roles: [{ key: "FAKE_BUILTIN", name: "Fake", permissions: [], isSystem: true }],
      }),
    );
    expect(errors).toMatch(/isSystem cannot be set from a preset/);
  });

  it("accepts the baseline permission and keeps it out of the stored set", () => {
    // staff.self is the floor every role already holds. Listing it states
    // something already true; refusing a statement of fact would make a file
    // written from what the admin screen shows fail to load.
    const result = parsePresetBundle({
      kind: "roles",
      name: "roles",
      roles: [{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["staff.self", "sales.read"] }],
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    const preset = result.bundle.presets[0];
    if (preset.kind !== "roles") throw new Error("narrowing");
    expect(grantablePermissions(preset.roles[0].permissions)).toEqual(["sales.read"]);
  });

  it("collapses duplicates and sorts, so a re-ordered list is not a change", () => {
    expect(grantablePermissions(["sales.write", "sales.read", "sales.read"])).toEqual([
      "sales.read",
      "sales.write",
    ]);
  });

  it("requires a key in the built-ins' spelling", () => {
    expect(
      expectFailure(
        parsePresetBundle({
          kind: "roles",
          name: "roles",
          roles: [{ key: "floor-lead", name: "Floor Lead", permissions: [] }],
        }),
      ),
    ).toMatch(/UPPER_SNAKE_CASE/);
  });

  it("rejects the same role key twice in one preset", () => {
    // Role.key is unique, so the second entry would simply overwrite the
    // first — in a GitOps flow that reads as "my change did nothing".
    expect(
      expectFailure(
        parsePresetBundle({
          kind: "roles",
          name: "roles",
          roles: [
            { key: "FLOOR_LEAD", name: "A", permissions: [] },
            { key: "FLOOR_LEAD", name: "B", permissions: ["sales.read"] },
          ],
        }),
      ),
    ).toMatch(/duplicate role key "FLOOR_LEAD"/);
  });

  it("requires permissions to be stated, not inferred from absence", () => {
    // An omitted list would read as "no opinion" while meaning "revoke
    // everything" — the author has to write `permissions: []` and mean it.
    expect(
      expectFailure(
        parsePresetBundle({
          kind: "roles",
          name: "roles",
          roles: [{ key: "FLOOR_LEAD", name: "Floor Lead" }],
        }),
      ),
    ).toMatch(/roles\.0\.permissions/);
  });
});

describe("roles preset — YAML / JSON parity", () => {
  const YAML = [
    "version: 1",
    "presets:",
    "  - kind: roles",
    "    name: roles",
    "    roles:",
    "      - key: FLOOR_LEAD",
    "        name: Floor Lead",
    "        rank: 1",
    "        permissions:",
    "          - sales.read",
    "          - sales.write",
    "",
  ].join("\n");

  const JSON_TEXT = JSON.stringify({
    version: 1,
    presets: [
      {
        kind: "roles",
        name: "roles",
        roles: [
          {
            key: "FLOOR_LEAD",
            name: "Floor Lead",
            rank: 1,
            permissions: ["sales.read", "sales.write"],
          },
        ],
      },
    ],
  });

  it("parses both spellings to an identical bundle", () => {
    const fromYaml = parsePresetText(YAML, "yaml");
    const fromJson = parsePresetText(JSON_TEXT, "json");
    if (!fromYaml.ok || !fromJson.ok) throw new Error("expected both to parse");
    expect(fromYaml.bundle).toEqual(fromJson.bundle);
  });

  it("round-trips through either format without drift, deterministically", () => {
    const parsed = parsePresetText(YAML, "yaml");
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    for (const format of ["yaml", "json"] as const) {
      const text = serializePresetBundle(parsed.bundle, format);
      expect(serializePresetBundle(parsed.bundle, format)).toBe(text);
      const reparsed = parsePresetText(text, format);
      if (!reparsed.ok) throw new Error(reparsed.errors.join("; "));
      expect(reparsed.bundle).toEqual(parsed.bundle);
    }
  });
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe("applyPreset — roles", () => {
  it("creates a role the deployment invented, with its grants", async () => {
    const { db, roles, grantsOf } = createFakeDb();
    const result = await applyPreset(
      rolesPreset([
        {
          key: "FLOOR_LEAD",
          name: "Floor Lead",
          rank: 1,
          permissions: ["sales.read", "sales.write"],
        },
      ]),
      opts(db),
    );

    expect(result.action).toBe("APPLIED");
    // 1 role + 2 grants.
    expect(result.changes).toEqual({ created: 3, updated: 0, deleted: 0 });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      key: "FLOOR_LEAD",
      name: "Floor Lead",
      rank: 1,
      isSystem: false,
      grantsAllPermissions: false,
    });
    expect(grantsOf("FLOOR_LEAD")).toEqual(["sales.read", "sales.write"]);
  });

  it("is idempotent — a second apply is UNCHANGED and writes nothing", async () => {
    const { db } = createFakeDb();
    const preset = rolesPreset([
      { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] },
    ]);

    expect((await applyPreset(preset, opts(db))).action).toBe("APPLIED");
    db.role.upsert.mockClear();
    db.role.update.mockClear();
    db.rolePermission.createMany.mockClear();
    db.rolePermission.deleteMany.mockClear();

    const second = await applyPreset(preset, opts(db));

    expect(second.action).toBe("UNCHANGED");
    expect(second.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(db.role.upsert).not.toHaveBeenCalled();
    expect(db.role.update).not.toHaveBeenCalled();
    expect(db.rolePermission.createMany).not.toHaveBeenCalled();
    expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it("revokes a permission deleted from the file (whole-set, not additive)", async () => {
    // Rule 63: a preset is desired state. Without this the file quietly stops
    // describing the deployment the first time someone removes a line.
    const { db, grantsOf } = createFakeDb();
    await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read", "sales.discount"] },
      ]),
      opts(db),
    );

    const result = await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("APPLIED");
    expect(result.changes).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect(result.messages).toContain('role "FLOOR_LEAD": revoked sales.discount');
    expect(grantsOf("FLOOR_LEAD")).toEqual(["sales.read"]);
  });

  it("leaves a role the preset stops listing alone", async () => {
    // Deliberate scope limit: rule 63's delete applies to the grants, not to
    // the Role row. Deleting a role strands its staff and can remove the last
    // holder of staff.manage; that needs the admin API's reassignment target.
    const { db, roles } = createFakeDb();
    await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] },
        { key: "NIGHT_CREW", name: "Night Crew", permissions: ["warehouse.read"] },
      ]),
      opts(db),
    );

    const result = await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("UNCHANGED");
    expect(roles.map((r) => r.key).sort()).toEqual(["FLOOR_LEAD", "NIGHT_CREW"]);
  });

  it("edits a built-in role's grants and takes ownership of them", async () => {
    const { db, roles, grantsOf } = createFakeDb([
      {
        key: "DESIGNER",
        name: "Designer",
        isSystem: true,
        permissions: ["sales.read", "reporting.read"],
      },
    ]);

    const result = await applyPreset(
      rolesPreset([{ key: "DESIGNER", name: "Designer", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("APPLIED");
    expect(grantsOf("DESIGNER")).toEqual(["sales.read"]);
    // The flag is what stops the deploy-time seeder putting reporting.read
    // back on the next release.
    expect(roles[0].grantsCustomized).toBe(true);
  });

  it("claims a built-in's grants even when they already match, then settles", async () => {
    // Without this, a preset that agrees with today's shipped grants leaves
    // grantsCustomized false — and the first release that adds a permission to
    // that role has the seeder add it and this preset take it away, on every
    // run, forever. Claiming ownership once ends the ping-pong.
    const { db, roles } = createFakeDb([
      { key: "DESIGNER", name: "Designer", isSystem: true, permissions: ["sales.read"] },
    ]);
    const preset = rolesPreset([
      { key: "DESIGNER", name: "Designer", permissions: ["sales.read"] },
    ]);

    const first = await applyPreset(preset, opts(db));
    expect(first.action).toBe("APPLIED");
    expect(first.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(roles[0].grantsCustomized).toBe(true);

    expect((await applyPreset(preset, opts(db))).action).toBe("UNCHANGED");
  });

  it("refuses to contradict a built-in role's identity", async () => {
    // Writing it would lose to the next deploy's seeder and win again at the
    // next apply — the ping-pong rule 63 forbids. Failing is stable.
    const { db, roles } = createFakeDb([
      { key: "DESIGNER", name: "Designer", isSystem: true, permissions: ["sales.read"] },
    ]);

    const result = await applyPreset(
      rolesPreset([{ key: "DESIGNER", name: "Sales Associate", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/ships with the product, and its name/);
    expect(roles[0].name).toBe("Designer");
  });

  it("refuses to narrow a wildcard role", async () => {
    // The permission check short-circuits on grantsAllPermissions before
    // RolePermission is read, so the rows this would write authorize nothing
    // while reading as policy in the admin UI.
    const { db, grants } = createFakeDb([
      { key: "SUPER_ADMIN", name: "Owner", isSystem: true, grantsAllPermissions: true },
    ]);

    const result = await applyPreset(
      rolesPreset([{ key: "SUPER_ADMIN", name: "Owner", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/holds every permission via the wildcard/);
    expect(grants).toHaveLength(0);
  });

  it("refuses to invent a built-in role that has not been seeded", async () => {
    // Otherwise the preset creates an isSystem=false impostor under a reserved
    // key and the seeder then fights it for ownership.
    const { db, roles } = createFakeDb();

    const result = await applyPreset(
      rolesPreset([{ key: "MANAGER", name: "Manager", permissions: ["sales.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/built-in role seeder/);
    expect(roles).toHaveLength(0);
  });

  it("stores no row for the baseline permission, and does not call it a change", async () => {
    const { db, grantsOf } = createFakeDb();
    await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts(db),
    );

    const result = await applyPreset(
      rolesPreset([
        { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["staff.self", "sales.read"] },
      ]),
      opts(db),
    );

    expect(result.action).toBe("UNCHANGED");
    expect(grantsOf("FLOOR_LEAD")).toEqual(["sales.read"]);
  });

  it("invalidates the role grant cache on every write", async () => {
    // A revocation that takes up to the cache TTL to bite is a security bug,
    // not a staleness annoyance.
    const { db } = createFakeDb();
    const preset = rolesPreset([
      { key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] },
    ]);

    await applyPreset(preset, opts(db));
    expect(invalidateMock).toHaveBeenCalledTimes(1);

    // Nothing written, nothing to invalidate.
    invalidateMock.mockClear();
    await applyPreset(preset, opts(db));
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("writes nothing at all on a dry run, cache included", async () => {
    const { db, roles, grants } = createFakeDb();
    const result = await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts(db, { dryRun: true }),
    );

    expect(result.action).toBe("APPLIED");
    expect(result.changes).toEqual({ created: 2, updated: 0, deleted: 0 });
    expect(roles).toHaveLength(0);
    expect(grants).toHaveLength(0);
    expect(db.configChangeLog.create).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it("reports every problem in one pass rather than only the first", async () => {
    const { db } = createFakeDb([
      { key: "SUPER_ADMIN", name: "Owner", isSystem: true, grantsAllPermissions: true },
      { key: "DESIGNER", name: "Designer", isSystem: true, permissions: [] },
    ]);

    const result = await applyPreset(
      rolesPreset([
        { key: "SUPER_ADMIN", name: "Owner", permissions: [] },
        { key: "DESIGNER", name: "Renamed", permissions: [] },
      ]),
      opts(db),
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages).toHaveLength(2);
  });

  it("refuses a revocation that would leave nobody able to manage staff", async () => {
    // The same guard the admin API's PUT and DELETE run (rule 42), asked about
    // the state this apply is about to write. One active, signed-in person, on
    // one role, and the file takes staff.manage away from it.
    const { db, grantsOf } = createFakeDb(
      [{ key: "OFFICE", name: "Office", permissions: ["staff.manage", "staff.read"] }],
      [{ role: "DESIGNER", roleId: 1 }],
    );

    const result = await applyPreset(
      rolesPreset([{ key: "OFFICE", name: "Office", permissions: ["staff.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("FAILED");
    expect(result.messages.join(" ")).toMatch(/no active staff member able to manage staff/);
    expect(grantsOf("OFFICE")).toEqual(["staff.manage", "staff.read"]);
  });

  it("allows the same revocation when someone else still holds it", async () => {
    const { db, grantsOf } = createFakeDb(
      [
        { key: "OFFICE", name: "Office", permissions: ["staff.manage", "staff.read"] },
        { key: "BACK_OFFICE", name: "Back Office", permissions: ["staff.manage"] },
      ],
      [
        { role: "DESIGNER", roleId: 1 },
        { role: "DESIGNER", roleId: 2 },
      ],
    );

    const result = await applyPreset(
      rolesPreset([{ key: "OFFICE", name: "Office", permissions: ["staff.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("APPLIED");
    expect(grantsOf("OFFICE")).toEqual(["staff.read"]);
  });

  it("does not consult the guard when the apply only adds", async () => {
    // Creating a role or granting a permission cannot take staff.manage away,
    // so the guard's two reads are skipped rather than paid for on every run.
    const { db } = createFakeDb();
    await applyPreset(
      rolesPreset([{ key: "FLOOR_LEAD", name: "Floor Lead", permissions: ["sales.read"] }]),
      opts(db),
    );
    expect(db.staffMember.findMany).not.toHaveBeenCalled();
  });

  it("lets a fresh deployment apply its roles before it has any staff", async () => {
    // Nobody to lock out is not a lockout. A guard that refused the first
    // apply would make the GitOps door unusable exactly where it starts.
    const { db, grantsOf } = createFakeDb([
      { key: "OFFICE", name: "Office", permissions: ["staff.manage"] },
    ]);

    const result = await applyPreset(
      rolesPreset([{ key: "OFFICE", name: "Office", permissions: ["staff.read"] }]),
      opts(db),
    );

    expect(result.action).toBe("APPLIED");
    expect(grantsOf("OFFICE")).toEqual(["staff.read"]);
  });

  it("records an empty roles list as a preset that simply says nothing", async () => {
    const { db } = createFakeDb();
    const result = await applyPreset(rolesPreset([]), opts(db));
    expect(result.action).toBe("UNCHANGED");
    expect(db.role.findMany).not.toHaveBeenCalled();
  });
});
