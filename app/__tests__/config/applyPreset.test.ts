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

import * as fs from "node:fs";
import * as path from "node:path";

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
type ChangeLogFindManyArgs = {
  where: { presetKind: string; presetName?: string; action?: { in: string[] } };
  orderBy?: { created: "asc" | "desc" };
};

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
    // Real Prisma `upsert` keyed on the @@unique([name]) constraint
    // (migration 20260804120000). applyPreset.ts uses this for the
    // brand-new-definition path so two concurrent applies of the same
    // preset name converge onto one row instead of duplicating it.
    upsert: jest.Mock<
      Promise<FakeDefinition>,
      [{ where: { name: string }; create: DefinitionCreateData; update: Partial<DefinitionCreateData> }]
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
    // Used by currentTrafficStoreOwners (applyPreset.ts) to scan ownership
    // across EVERY traffic-store-mapping preset, not just one preset's own
    // history -- no presetName filter, unlike findFirst above.
    findMany: jest.Mock<Promise<FakeChangeLog[]>, [ChangeLogFindManyArgs]>;
  };
  $transaction: jest.Mock<Promise<unknown>, [(tx: FakeDb) => Promise<unknown>, unknown?]>;
}

/** Newest-first by default (created desc, ties broken by id desc, mirroring
 *  insertion order) -- shared by configChangeLog.findFirst and .findMany
 *  above so the two stay consistent with each other. */
function sortChangeLogs(rows: FakeChangeLog[], orderBy?: { created: "asc" | "desc" }): FakeChangeLog[] {
  const sorted = [...rows].sort((a, b) => {
    const byTime = b.created.getTime() - a.created.getTime();
    return byTime !== 0 ? byTime : b.id - a.id;
  });
  if (orderBy?.created === "asc") sorted.reverse();
  return sorted;
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
      // Mirrors real Prisma upsert semantics keyed on the unique `name`:
      // find-by-name first, update in place if found, else create. Doing
      // the lookup here (rather than trusting whatever the caller last saw
      // via findFirst) is exactly what makes this race-safe -- a row
      // inserted by a "concurrent" write between the caller's findFirst and
      // this upsert is still found here and updated, never duplicated.
      upsert: jest.fn(async ({ where, create, update }) => {
        const row = definitions.find((d) => d.name === where.name);
        if (row) {
          Object.assign(row, update);
          return { ...row };
        }
        const created: FakeDefinition = { id: nextDefId++, fieldMappings: [], valueMappings: [], ...create };
        definitions.push(created);
        return { ...created };
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
        rows = sortChangeLogs(rows, orderBy);
        return rows[0] ?? null;
      }),
      // No presetName filter -- currentTrafficStoreOwners scans across
      // every preset of this kind to find each store's real current owner.
      findMany: jest.fn(async ({ where, orderBy }) => {
        let rows = changeLogs.filter((r) => r.presetKind === where.presetKind);
        if (where.presetName !== undefined) {
          rows = rows.filter((r) => r.presetName === where.presetName);
        }
        if (where.action?.in) {
          const allowed = where.action.in;
          rows = rows.filter((r) => allowed.includes(r.action));
        }
        return sortChangeLogs(rows, orderBy);
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

  it("does not abort the apply, or the rest of the bundle, when writing the ConfigChangeLog row throws", async () => {
    const { db, definitions, stores, changeLogs } = createFakeDb([{ name: "Downtown" }]);
    // Seed history as if "traffic-stores" already owns Downtown, so the
    // second preset below is a real declarative delete -- exactly the kind
    // of write that used to be silently lost if a bundle aborted after an
    // earlier preset's audit write failed.
    stores[0].trafficSourceNames = ["DT"];
    changeLogs.push({
      id: 999,
      presetKind: "traffic-store-mapping",
      presetName: "traffic-stores",
      action: "APPLIED",
      source: "seed",
      actor: null,
      created: new Date(0),
      summary: { ownedStores: ["Downtown"] },
    });

    db.configChangeLog.create.mockImplementationOnce(async () => {
      throw new Error("simulated ConfigChangeLog write failure");
    });

    const bundle = {
      version: 1 as const,
      presets: [
        importDefPreset({ name: "first-preset" }),
        trafficPreset({ name: "traffic-stores", stores: [] }),
      ],
    };

    const results = await applyBundle(bundle, opts(db));

    expect(results).toHaveLength(2);
    // The first preset's real write happened -- the audit row is a RECORD
    // of the apply, not a precondition for it.
    expect(results[0].action).toBe("APPLIED");
    expect(definitions.some((d) => d.name === "first-preset")).toBe(true);
    // The bundle did not abort: the second preset was still processed, and
    // its declarative delete actually landed.
    expect(results[1].action).toBe("APPLIED");
    expect(stores[0].trafficSourceNames).toEqual([]);
    // The first preset's audit row is the one casualty of the simulated
    // failure -- acceptable, since the underlying write already succeeded.
    // The second preset's own audit write, using the unmodified mock
    // implementation, still succeeds normally.
    expect(changeLogs.filter((c) => c.presetName === "first-preset")).toHaveLength(0);
    expect(changeLogs.some((c) => c.presetName === "traffic-stores" && c.id !== 999)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Value-mapping key collisions (a literal NUL byte used to sit here)
// ---------------------------------------------------------------------------

describe("import-definition value mapping keys", () => {
  it("never reintroduces a literal NUL byte into applyPreset.ts (regression guard)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "lib", "config", "applyPreset.ts"),
      "utf8",
    );
    expect(src.includes("\u0000")).toBe(false);
  });

  it("keeps two value mappings distinct even when a target field or source value contains an " +
    "embedded NUL character (regression guard for the old NUL-delimited key, which collided here)",
    async () => {
      const { db, definitions } = createFakeDb();
      // Under the old `${targetField}\0${sourceValue}` key, these two DIFFERENT
      // pairs produced the SAME string: "a\0b" + "\0" + "c" === "a" + "\0" + "b\0c".
      const NUL = String.fromCharCode(0);
      const preset = importDefPreset({
        fieldMappings: [{ sourceColumn: "Customer Code", targetField: "externalId" }],
        valueMappings: {
          [`a${NUL}b`]: { c: "first" },
          a: { [`b${NUL}c`]: "second" },
        },
      });

      const result = await applyPreset(preset, opts(db));

      expect(result.action).toBe("APPLIED");
      expect(definitions[0].valueMappings).toHaveLength(2);
      const targetValues = definitions[0].valueMappings.map((v) => v.targetValue).sort();
      expect(targetValues).toEqual(["first", "second"]);
    },
  );
});

// ---------------------------------------------------------------------------
// import-definition: race-safe upsert (item 3) and targetEntity on an
// existing, active definition (item 4)
// ---------------------------------------------------------------------------

describe("applyPreset — import-definition — concurrency and targetEntity safety", () => {
  it("does not create a duplicate ImportDefinition when a concurrent apply already created the row " +
    "between the read and the write", async () => {
      const { db, definitions } = createFakeDb();
      const preset = importDefPreset({ name: "concurrent-preset" });

      // Simulate the race directly: seed the row a "concurrent" apply already
      // created, but make THIS apply's pre-transaction read still see null --
      // exactly what happens when two applies of a brand-new preset name
      // interleave around that read.
      definitions.push({
        id: 999,
        name: "concurrent-preset",
        description: null,
        targetEntity: "customer",
        sourceFormat: "CSV",
        importMode: "INSERT_ONLY",
        naturalKeyFields: [],
        runnerKey: null,
        isActive: true,
        fieldMappings: [],
        valueMappings: [],
      });
      db.importDefinition.findFirst.mockImplementationOnce(async () => null);

      const result = await applyPreset(preset, opts(db));

      expect(result.action).toBe("APPLIED");
      // The critical assertion: still exactly ONE row for this name, not two.
      const matching = definitions.filter((d) => d.name === "concurrent-preset");
      expect(matching).toHaveLength(1);
      expect(matching[0].id).toBe(999); // converged onto the "concurrent" row, not a new one
    },
  );

  it("fails loudly instead of silently deactivating an EXISTING, active definition when " +
    "targetEntity becomes unknown (e.g. a typo)", async () => {
      const { db, definitions } = createFakeDb();
      const v1 = importDefPreset({ name: "typo-prone", targetEntity: "customer", isActive: true });
      const first = await applyPreset(v1, opts(db));
      expect(first.action).toBe("APPLIED");
      expect(definitions[0].isActive).toBe(true);

      const v2 = importDefPreset({ name: "typo-prone", targetEntity: "custoemr", isActive: true });
      const second = await applyPreset(v2, opts(db));

      expect(second.action).toBe("FAILED");
      expect(second.messages[0]).toMatch(/not in IMPORT_ENTITIES/);
      expect(second.messages[0]).toMatch(/active/i);
      expect(second.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
      // The live definition was NOT silently switched off or retargeted.
      expect(definitions[0].isActive).toBe(true);
      expect(definitions[0].targetEntity).toBe("customer");
    },
  );

  it("still saves-but-forces-inactive when targetEntity is unknown on an EXISTING but already " +
    "inactive definition (nothing live is being switched off)", async () => {
      const { db, definitions } = createFakeDb();
      const v1 = importDefPreset({ name: "already-off", targetEntity: "customer", isActive: false });
      await applyPreset(v1, opts(db));
      expect(definitions[0].isActive).toBe(false);

      const v2 = importDefPreset({ name: "already-off", targetEntity: "not-a-real-entity", isActive: true });
      const result = await applyPreset(v2, opts(db));

      expect(result.action).toBe("APPLIED");
      expect(definitions[0].isActive).toBe(false); // forced, still
      expect(definitions[0].targetEntity).toBe("not-a-real-entity");
    },
  );
});

// ---------------------------------------------------------------------------
// traffic-store-mapping: ownership (items 1 and 2)
// ---------------------------------------------------------------------------

describe("applyPreset — traffic-store-mapping — ownership", () => {
  it("fails a differently-named preset that claims a store another traffic-store-mapping preset " +
    "already owns, and keeps failing (converges) on re-apply", async () => {
      const { db } = createFakeDb([{ name: "Downtown" }]);
      const first = trafficPreset({
        name: "storefront-a",
        stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
      });
      const firstResult = await applyPreset(first, opts(db));
      expect(firstResult.action).toBe("APPLIED");

      const second = trafficPreset({
        name: "storefront-b",
        stores: [{ storeLocation: "Downtown", sourceNames: ["DT2"] }],
      });
      const secondResult = await applyPreset(second, opts(db));
      expect(secondResult.action).toBe("FAILED");
      expect(secondResult.messages[0]).toMatch(
        /already owned by traffic-store-mapping preset "storefront-a"/,
      );

      // The true owner stays healthy...
      const firstReapply = await applyPreset(first, opts(db));
      expect(firstReapply.action).toBe("UNCHANGED");

      // ...and the second preset keeps failing deterministically, rather
      // than the two trading ownership back and forth on every re-apply
      // (which is what "idempotent" has to mean once two presets can name
      // the same store).
      const secondReapply = await applyPreset(second, opts(db));
      expect(secondReapply.action).toBe("FAILED");
    },
  );

  it("does not conflict with itself on a normal re-apply (owner === this preset)", async () => {
    const { db } = createFakeDb([{ name: "Downtown" }]);
    const preset = trafficPreset({
      name: "traffic-stores",
      stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
    });
    await applyPreset(preset, opts(db));
    const second = await applyPreset(preset, opts(db));
    expect(second.action).toBe("UNCHANGED");
  });

  it("fails loudly (rather than silently reporting no changes) when a renamed preset still claims " +
    "a store owned under its old name", async () => {
      const { db, stores } = createFakeDb([{ name: "Downtown" }, { name: "Uptown" }]);
      const original = trafficPreset({
        name: "old-name",
        stores: [
          { storeLocation: "Downtown", sourceNames: ["DT"] },
          { storeLocation: "Uptown", sourceNames: ["UT"] },
        ],
      });
      await applyPreset(original, opts(db));
      expect(stores.find((s) => s.name === "Uptown")?.trafficSourceNames).toEqual(["UT"]);

      // Same preset, renamed, AND Uptown dropped in the same edit -- the
      // exact "rename + drop a store" scenario that used to silently no-op.
      const renamed = trafficPreset({
        name: "new-name",
        stores: [{ storeLocation: "Downtown", sourceNames: ["DT"] }],
      });
      const result = await applyPreset(renamed, opts(db));

      expect(result.action).toBe("FAILED");
      expect(result.messages[0]).toMatch(/already owned by traffic-store-mapping preset "old-name"/);
      // Nothing was silently dropped: Uptown (still owned by "old-name") is
      // untouched, not cleared out from under it by the failed rename.
      expect(stores.find((s) => s.name === "Uptown")?.trafficSourceNames).toEqual(["UT"]);
    },
  );
});
