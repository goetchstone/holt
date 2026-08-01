// /app/__tests__/config/applyPreset.test.ts
//
// Pure diffing-logic tests for applyPreset.ts. There is no module-level
// mocking of the shared Prisma singleton here, on purpose: applyPreset()
// takes its PrismaClient via opts.prisma (dependency injection), so every
// test below hands it a small in-memory fake that implements just the
// handful of methods applyPreset.ts calls. The fake is real enough that a
// scenario can call applyPreset() twice in a row and see the second call
// observe the first call's writes -- which is exactly what the idempotency
// and delete-on-removal tests need. Because the shared client module is
// never replaced, this file does not trip testGrading.test.ts's
// placeholder-header rule (that rule is about swapping out the DB module
// entirely, not about dependency-injected fakes).
//
// Headline property under test: a preset is a desired-state declaration.
// Applying it twice must write nothing the second time (UNCHANGED), and
// removing a mapping/store from the preset then re-applying must delete the
// corresponding row.

import {
  importDefinitionPresetSchema,
  trafficStoreMappingPresetSchema,
  type ImportDefinitionPreset,
  type TrafficStoreMappingPreset,
} from "@/lib/config/presetSchema";
import { applyBundle, applyPreset } from "@/lib/config/applyPreset";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function importDefPreset(overrides: Record<string, unknown> = {}): ImportDefinitionPreset {
  return importDefinitionPresetSchema.parse({
    kind: "import-definition",
    name: "acme-customers",
    targetEntity: "customer",
    fieldMappings: [{ sourceColumn: "Customer Code", targetField: "externalId" }],
    valueMappings: {},
    ...overrides,
  });
}

function trafficPreset(overrides: Record<string, unknown> = {}): TrafficStoreMappingPreset {
  return trafficStoreMappingPresetSchema.parse({
    kind: "traffic-store-mapping",
    name: "traffic-stores",
    stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// In-memory fake Prisma client
// ---------------------------------------------------------------------------
//
// Backs applyPreset.ts's read-then-write pattern with real arrays (not
// canned return values) so successive applyPreset() calls against the same
// fake see each other's writes, the same way a real database would.

interface FakeFieldMapping {
  id: number;
  targetField: string;
  sourceColumn: string;
  transform: string | null;
  required: boolean;
  sortOrder: number;
}
interface FakeValueMapping {
  id: number;
  targetField: string;
  sourceValue: string;
  targetValue: string;
}
interface FakeDefinition {
  id: number;
  name: string;
  description: string | null;
  targetEntity: string;
  sourceFormat: string;
  importMode: string;
  naturalKeyFields: string[];
  runnerKey: string | null;
  isActive: boolean;
  fieldMappings: FakeFieldMapping[];
  valueMappings: FakeValueMapping[];
}
interface FakeStoreLocation {
  id: number;
  name: string;
  trafficSourceNames: string[];
}
interface FakeChangeLog {
  id: number;
  presetKind: string;
  presetName: string;
  action: string;
  source: string;
  actor: string | null;
  summary: unknown;
  created: Date;
}

type DefinitionCreateData = Omit<FakeDefinition, "id" | "fieldMappings" | "valueMappings">;
type FieldMappingCreateData = Omit<FakeFieldMapping, "id"> & { definitionId: number };
type ValueMappingCreateData = Omit<FakeValueMapping, "id"> & { definitionId: number };
type ChangeLogCreateData = Omit<FakeChangeLog, "id" | "created">;

// Explicitly typed (rather than inferred from the object literal below) so
// the self-reference inside $transaction's implementation — it hands the
// callback the very same fake db — doesn't create a circular-inference
// error.
interface FakeDb {
  importDefinition: {
    findFirst: jest.Mock<Promise<FakeDefinition | null>, [{ where: { name: string } }]>;
    create: jest.Mock<Promise<FakeDefinition>, [{ data: DefinitionCreateData }]>;
    update: jest.Mock<
      Promise<FakeDefinition>,
      [{ where: { id: number }; data: Partial<DefinitionCreateData> }]
    >;
  };
  importFieldMapping: {
    create: jest.Mock<Promise<FakeFieldMapping>, [{ data: FieldMappingCreateData }]>;
    update: jest.Mock<
      Promise<FakeFieldMapping>,
      [{ where: { id: number }; data: Partial<Omit<FakeFieldMapping, "id">> }]
    >;
    delete: jest.Mock<Promise<FakeFieldMapping>, [{ where: { id: number } }]>;
  };
  importValueMapping: {
    create: jest.Mock<Promise<FakeValueMapping>, [{ data: ValueMappingCreateData }]>;
    update: jest.Mock<
      Promise<FakeValueMapping>,
      [{ where: { id: number }; data: Partial<Omit<FakeValueMapping, "id">> }]
    >;
    delete: jest.Mock<Promise<FakeValueMapping>, [{ where: { id: number } }]>;
  };
  storeLocation: {
    findMany: jest.Mock<Promise<FakeStoreLocation[]>, [{ where?: { name?: { in?: string[] } } }?]>;
    update: jest.Mock<
      Promise<FakeStoreLocation>,
      [{ where: { id: number }; data: { trafficSourceNames: string[] } }]
    >;
  };
  configChangeLog: {
    create: jest.Mock<Promise<FakeChangeLog>, [{ data: ChangeLogCreateData }]>;
    findFirst: jest.Mock<
      Promise<FakeChangeLog | null>,
      [
        {
          where: { presetKind: string; presetName: string; action?: { in: string[] } };
          orderBy?: { created: "asc" | "desc" };
        },
      ]
    >;
  };
  $transaction: jest.Mock<Promise<unknown>, [(tx: FakeDb) => Promise<unknown>, unknown?]>;
}

function createFakeDb(seedStores: Array<{ name: string }> = []) {
  let nextDefId = 1;
  let nextFieldId = 1;
  let nextValueId = 1;
  let nextStoreId = 1;
  let nextLogId = 1;

  const definitions: FakeDefinition[] = [];
  const stores: FakeStoreLocation[] = seedStores.map((s) => ({
    id: nextStoreId++,
    name: s.name,
    trafficSourceNames: [],
  }));
  const changeLogs: FakeChangeLog[] = [];

  function findFieldMappingHome(id: number): { def: FakeDefinition; row: FakeFieldMapping } | null {
    for (const def of definitions) {
      const row = def.fieldMappings.find((f) => f.id === id);
      if (row) return { def, row };
    }
    return null;
  }
  function findValueMappingHome(id: number): { def: FakeDefinition; row: FakeValueMapping } | null {
    for (const def of definitions) {
      const row = def.valueMappings.find((v) => v.id === id);
      if (row) return { def, row };
    }
    return null;
  }

  const db: FakeDb = {
    importDefinition: {
      findFirst: jest.fn(async ({ where }) => {
        const def = definitions.find((d) => d.name === where.name);
        if (!def) return null;
        return {
          ...def,
          fieldMappings: def.fieldMappings.map((f) => ({ ...f })),
          valueMappings: def.valueMappings.map((v) => ({ ...v })),
        };
      }),
      create: jest.fn(async ({ data }) => {
        const row: FakeDefinition = { id: nextDefId++, fieldMappings: [], valueMappings: [], ...data };
        definitions.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = definitions.find((d) => d.id === where.id);
        if (!row) throw new Error(`ImportDefinition ${where.id} not found`);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    importFieldMapping: {
      create: jest.fn(async ({ data }) => {
        const def = definitions.find((d) => d.id === data.definitionId);
        if (!def) throw new Error(`ImportDefinition ${data.definitionId} not found`);
        const row: FakeFieldMapping = {
          id: nextFieldId++,
          targetField: data.targetField,
          sourceColumn: data.sourceColumn,
          transform: data.transform,
          required: data.required,
          sortOrder: data.sortOrder,
        };
        def.fieldMappings.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }) => {
        const home = findFieldMappingHome(where.id);
        if (!home) throw new Error(`ImportFieldMapping ${where.id} not found`);
        Object.assign(home.row, data);
        return { ...home.row };
      }),
      delete: jest.fn(async ({ where }) => {
        const home = findFieldMappingHome(where.id);
        if (!home) throw new Error(`ImportFieldMapping ${where.id} not found`);
        home.def.fieldMappings = home.def.fieldMappings.filter((f) => f.id !== where.id);
        return home.row;
      }),
    },
    importValueMapping: {
      create: jest.fn(async ({ data }) => {
        const def = definitions.find((d) => d.id === data.definitionId);
        if (!def) throw new Error(`ImportDefinition ${data.definitionId} not found`);
        const row: FakeValueMapping = {
          id: nextValueId++,
          targetField: data.targetField,
          sourceValue: data.sourceValue,
          targetValue: data.targetValue,
        };
        def.valueMappings.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }) => {
        const home = findValueMappingHome(where.id);
        if (!home) throw new Error(`ImportValueMapping ${where.id} not found`);
        Object.assign(home.row, data);
        return { ...home.row };
      }),
      delete: jest.fn(async ({ where }) => {
        const home = findValueMappingHome(where.id);
        if (!home) throw new Error(`ImportValueMapping ${where.id} not found`);
        home.def.valueMappings = home.def.valueMappings.filter((v) => v.id !== where.id);
        return home.row;
      }),
    },
    storeLocation: {
      findMany: jest.fn(async (args) => {
        const names = args?.where?.name?.in;
        return stores
          .filter((s) => !names || names.includes(s.name))
          .map((s) => ({ ...s, trafficSourceNames: [...s.trafficSourceNames] }));
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = stores.find((s) => s.id === where.id);
        if (!row) throw new Error(`StoreLocation ${where.id} not found`);
        row.trafficSourceNames = [...data.trafficSourceNames];
        return { ...row };
      }),
    },
    configChangeLog: {
      create: jest.fn(async ({ data }) => {
        const row: FakeChangeLog = { id: nextLogId++, created: new Date(), ...data };
        changeLogs.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, orderBy }) => {
        let rows = changeLogs.filter(
          (r) => r.presetKind === where.presetKind && r.presetName === where.presetName,
        );
        if (where.action?.in) {
          const allowed = where.action.in;
          rows = rows.filter((r) => allowed.includes(r.action));
        }
        rows = [...rows].sort((a, b) => {
          const byTime = b.created.getTime() - a.created.getTime();
          return byTime !== 0 ? byTime : b.id - a.id;
        });
        if (orderBy?.created === "asc") rows.reverse();
        return rows[0] ?? null;
      }),
    },
    $transaction: jest.fn(async (fn) => fn(db)),
  };

  return { db, definitions, stores, changeLogs };
}

function opts(fake: FakeDb, extra: Record<string, unknown> = {}) {
  return { source: "test", prisma: fake as never, ...extra };
}

// ---------------------------------------------------------------------------
// import-definition
// ---------------------------------------------------------------------------

describe("applyPreset — import-definition", () => {
  it("creates a new definition with its field and value mappings", async () => {
    const { db, definitions } = createFakeDb();
    const preset = importDefPreset({
      fieldMappings: [
        { sourceColumn: "Customer Code", targetField: "externalId", required: true },
        { sourceColumn: "Email", targetField: "email" },
      ],
      valueMappings: { state: { Connecticut: "CT" } },
    });

    const result = await applyPreset(preset, opts(db));

    expect(result.action).toBe("APPLIED");
    // 1 new ImportDefinition + 2 field mappings + 1 value mapping.
    expect(result.changes).toEqual({ created: 4, updated: 0, deleted: 0 });
    expect(definitions).toHaveLength(1);
    expect(definitions[0].fieldMappings).toHaveLength(2);
    expect(definitions[0].valueMappings).toHaveLength(1);
    expect(definitions[0].isActive).toBe(true);
  });

  it("is idempotent: re-applying an unchanged preset is UNCHANGED with zero target-table writes", async () => {
    const { db } = createFakeDb();
    const preset = importDefPreset();

    const first = await applyPreset(preset, opts(db));
    expect(first.action).toBe("APPLIED");

    const createCallsBefore = db.importFieldMapping.create.mock.calls.length;
    const defUpdateCallsBefore = db.importDefinition.update.mock.calls.length;
    const defCreateCallsBefore = db.importDefinition.create.mock.calls.length;

    const second = await applyPreset(preset, opts(db));

    expect(second.action).toBe("UNCHANGED");
    expect(second.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
    // No writes to any target table on the second, identical apply.
    expect(db.importFieldMapping.create.mock.calls.length).toBe(createCallsBefore);
    expect(db.importDefinition.update.mock.calls.length).toBe(defUpdateCallsBefore);
    expect(db.importDefinition.create.mock.calls.length).toBe(defCreateCallsBefore);
    expect(db.importFieldMapping.update).not.toHaveBeenCalled();
    expect(db.importFieldMapping.delete).not.toHaveBeenCalled();
  });

  it("deletes a field mapping and a value mapping the preset no longer contains", async () => {
    const { db, definitions } = createFakeDb();
    const v1 = importDefPreset({
      fieldMappings: [
        { sourceColumn: "Customer Code", targetField: "externalId" },
        { sourceColumn: "Email", targetField: "email" },
      ],
      valueMappings: { state: { Connecticut: "CT", Massachusetts: "MA" } },
    });
    await applyPreset(v1, opts(db));
    expect(definitions[0].fieldMappings).toHaveLength(2);
    expect(definitions[0].valueMappings).toHaveLength(2);

    // Same name, but "email" and the Massachusetts mapping are gone.
    const v2 = importDefPreset({
      fieldMappings: [{ sourceColumn: "Customer Code", targetField: "externalId" }],
      valueMappings: { state: { Connecticut: "CT" } },
    });
    const result = await applyPreset(v2, opts(db));

    expect(result.action).toBe("APPLIED");
    expect(result.changes.deleted).toBe(2);
    expect(definitions[0].fieldMappings.map((f) => f.targetField)).toEqual(["externalId"]);
    expect(definitions[0].valueMappings.map((v) => v.sourceValue)).toEqual(["Connecticut"]);
    expect(result.messages.some((m) => m.includes('deleted field mapping "email"'))).toBe(true);
  });

  it("updates a changed field mapping in place rather than delete+create", async () => {
    const { db, definitions } = createFakeDb();
    const v1 = importDefPreset({
      fieldMappings: [{ sourceColumn: "Customer Code", targetField: "externalId", required: false }],
    });
    await applyPreset(v1, opts(db));
    const originalId = definitions[0].fieldMappings[0].id;

    const v2 = importDefPreset({
      fieldMappings: [{ sourceColumn: "Cust Code", targetField: "externalId", required: true }],
    });
    const result = await applyPreset(v2, opts(db));

    expect(result.action).toBe("APPLIED");
    expect(result.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(definitions[0].fieldMappings).toHaveLength(1);
    expect(definitions[0].fieldMappings[0].id).toBe(originalId);
    expect(definitions[0].fieldMappings[0].sourceColumn).toBe("Cust Code");
    expect(definitions[0].fieldMappings[0].required).toBe(true);
  });

  it("saves a definition with an unknown targetEntity but forces isActive false (does not fail)", async () => {
    const { db, definitions, changeLogs } = createFakeDb();
    const preset = importDefPreset({ targetEntity: "payment", isActive: true });

    const result = await applyPreset(preset, opts(db));

    expect(result.action).toBe("APPLIED");
    expect(definitions).toHaveLength(1);
    expect(definitions[0].targetEntity).toBe("payment");
    expect(definitions[0].isActive).toBe(false); // forced, despite preset saying true
    expect(result.messages.some((m) => /not in IMPORT_ENTITIES/.test(m) && /forced inactive/.test(m))).toBe(
      true,
    );

    // The reason lands in the durable ConfigChangeLog summary, not just the
    // transient ApplyResult, so an operator can see it months later.
    expect(changeLogs).toHaveLength(1);
    const summary = changeLogs[0].summary as Record<string, unknown>;
    expect(typeof summary.forcedInactiveReason).toBe("string");
    expect(summary.forcedInactiveReason as string).toMatch(/forced inactive/);
  });

  it("stays forced-inactive (and UNCHANGED) on re-apply of the same unknown-entity preset", async () => {
    const { db } = createFakeDb();
    const preset = importDefPreset({ targetEntity: "payment", isActive: true });
    await applyPreset(preset, opts(db));
    const second = await applyPreset(preset, opts(db));
    expect(second.action).toBe("UNCHANGED");
  });

  it("fails when runnerKey is not a registered runner, and writes nothing", async () => {
    const { db, definitions, changeLogs } = createFakeDb();
    const preset = importDefPreset({ runnerKey: "not-a-real-runner" });

    const result = await applyPreset(preset, opts(db));

    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toMatch(/runnerKey "not-a-real-runner" is not registered/);
    expect(definitions).toHaveLength(0);
    // FAILED still gets a durable audit row (per spec: APPLIED, UNCHANGED
    // and FAILED all get one) -- just no writes to the target tables.
    expect(changeLogs).toHaveLength(1);
    expect(changeLogs[0].action).toBe("FAILED");
  });

  it("dry run computes the diff but writes nothing, not even the audit row", async () => {
    const { db, definitions, changeLogs } = createFakeDb();
    const preset = importDefPreset();

    const result = await applyPreset(preset, opts(db, { dryRun: true }));

    expect(result.action).toBe("APPLIED");
    expect(result.changes.created).toBeGreaterThan(0);
    expect(definitions).toHaveLength(0); // nothing actually written
    expect(changeLogs).toHaveLength(0); // not even the audit row
    expect(db.importDefinition.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("wraps the reconcile in a single transaction when there are changes", async () => {
    const { db } = createFakeDb();
    const preset = importDefPreset();
    await applyPreset(preset, opts(db));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// traffic-store-mapping
// ---------------------------------------------------------------------------

describe("applyPreset — traffic-store-mapping", () => {
  it("fails when a named store does not exist, and never creates one", async () => {
    const { db, stores } = createFakeDb([{ name: "Downtown" }]);
    const preset = trafficPreset({
      stores: [{ storeLocation: "Uptown", sourceNames: ["UT"] }],
    });

    const result = await applyPreset(preset, opts(db));

    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toMatch(/unknown store\(s\): Uptown/);
    expect(stores).toHaveLength(1); // still just Downtown -- nothing created
    expect(db.storeLocation.update).not.toHaveBeenCalled();
  });

  it("rejects a source name claimed by two different stores in one preset", async () => {
    const { db } = createFakeDb([{ name: "Downtown" }, { name: "Uptown" }]);
    const preset = trafficPreset({
      stores: [
        { storeLocation: "Downtown", sourceNames: ["Main Door"] },
        { storeLocation: "Uptown", sourceNames: ["Main Door"] },
      ],
    });

    const result = await applyPreset(preset, opts(db));

    expect(result.action).toBe("FAILED");
    expect(result.messages[0]).toMatch(/ambiguous source name/);
    expect(db.storeLocation.update).not.toHaveBeenCalled();
  });

  it("sets trafficSourceNames on matching stores and is idempotent on re-apply", async () => {
    const { db, stores } = createFakeDb([{ name: "Downtown" }]);
    const preset = trafficPreset({
      stores: [{ storeLocation: "Downtown", sourceNames: ["DT", "Downtown Annex"] }],
    });

    const first = await applyPreset(preset, opts(db));
    expect(first.action).toBe("APPLIED");
    expect(stores[0].trafficSourceNames.sort()).toEqual(["DT", "Downtown Annex"]);

    const updateCallsBefore = db.storeLocation.update.mock.calls.length;
    const second = await applyPreset(preset, opts(db));
    expect(second.action).toBe("UNCHANGED");
    expect(db.storeLocation.update.mock.calls.length).toBe(updateCallsBefore);
  });

  it("clears trafficSourceNames on a store the preset stops claiming", async () => {
    const { db, stores } = createFakeDb([{ name: "Downtown" }, { name: "Uptown" }]);
    const v1 = trafficPreset({
      stores: [
        { storeLocation: "Downtown", sourceNames: ["DT"] },
        { storeLocation: "Uptown", sourceNames: ["UT"] },
      ],
    });
    await applyPreset(v1, opts(db));
    expect(stores.find((s) => s.name === "Uptown")?.trafficSourceNames).toEqual(["UT"]);

    // Same preset name, Uptown's block removed entirely.
    const v2 = trafficPreset({
      stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
    });
    const result = await applyPreset(v2, opts(db));

    expect(result.action).toBe("APPLIED");
    expect(result.changes.deleted).toBe(1);
    expect(stores.find((s) => s.name === "Uptown")?.trafficSourceNames).toEqual([]);
    expect(stores.find((s) => s.name === "Downtown")?.trafficSourceNames).toEqual(["DT"]);
    expect(result.messages.some((m) => m.includes('store "Uptown": cleared'))).toBe(true);
  });

  it("never touches a store outside this preset's own current+historical claim set", async () => {
    // "Other Store" was never mentioned by this preset (kind, name). A
    // clearing pass must never reach it -- that's the "never a blanket wipe
    // of every store" rule.
    const { db, stores } = createFakeDb([{ name: "Downtown" }, { name: "Other Store" }]);
    // Seed "Other Store" with pre-existing names as if some other mechanism
    // (hand-edit, a different preset) set them.
    stores.find((s) => s.name === "Other Store")!.trafficSourceNames = ["Preexisting"];

    const preset = trafficPreset({ stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }] });
    await applyPreset(preset, opts(db));

    expect(stores.find((s) => s.name === "Other Store")?.trafficSourceNames).toEqual(["Preexisting"]);
  });

  it("dry run writes nothing, not even the audit row", async () => {
    const { db, stores, changeLogs } = createFakeDb([{ name: "Downtown" }]);
    const preset = trafficPreset({
      stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
    });

    const result = await applyPreset(preset, opts(db, { dryRun: true }));

    expect(result.action).toBe("APPLIED");
    expect(stores[0].trafficSourceNames).toEqual([]); // unwritten
    expect(changeLogs).toHaveLength(0);
    expect(db.storeLocation.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// applyBundle
// ---------------------------------------------------------------------------

describe("applyBundle", () => {
  it("applies every preset in the bundle and returns one result per preset, independent of each other's failures", async () => {
    const { db } = createFakeDb([{ name: "Downtown" }]);
    const bundle = {
      version: 1 as const,
      presets: [
        importDefPreset({ name: "ok-definition" }),
        trafficPreset({ name: "bad-mapping", stores: [{ storeLocation: "Nonexistent", sourceNames: ["X"] }] }),
      ],
    };

    const results = await applyBundle(bundle, opts(db));

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ kind: "import-definition", name: "ok-definition", action: "APPLIED" });
    expect(results[1]).toMatchObject({ kind: "traffic-store-mapping", name: "bad-mapping", action: "FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe("ConfigChangeLog audit trail", () => {
  it("writes exactly one row per apply for APPLIED, UNCHANGED and FAILED alike", async () => {
    const { db, changeLogs } = createFakeDb([{ name: "Downtown" }]);

    await applyPreset(importDefPreset(), opts(db)); // APPLIED
    await applyPreset(importDefPreset(), opts(db)); // UNCHANGED
    await applyPreset(
      importDefPreset({ runnerKey: "nope" }),
      opts(db),
    ); // FAILED

    expect(changeLogs).toHaveLength(3);
    expect(changeLogs.map((c) => c.action)).toEqual(["APPLIED", "UNCHANGED", "FAILED"]);
    expect(changeLogs.every((c) => c.presetKind === "import-definition")).toBe(true);
    expect(changeLogs.every((c) => c.source === "test")).toBe(true);
  });

  it("records the actor when given, and falls back to a clear default when not", async () => {
    const { db, changeLogs } = createFakeDb();
    await applyPreset(importDefPreset({ name: "with-actor" }), opts(db, { actor: "ops@example.com" }));
    await applyPreset(importDefPreset({ name: "no-actor" }), opts(db));

    expect(changeLogs[0].actor).toBe("ops@example.com");
    expect(changeLogs[1].actor).toBeNull();
  });
});
