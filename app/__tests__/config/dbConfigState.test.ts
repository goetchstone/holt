// /app/__tests__/config/dbConfigState.test.ts
//
// loadDbConfigState() renders the live DB as a PresetBundle for the admin
// GUI's read path and the export route (lib/config/dbConfigState.ts). Two
// behaviours under test here, both about keeping that bundle re-importable
// (docs/domains/config-presets.md, "Round-trip is a load-bearing promise"):
//
//   - an ImportDefinition whose `name` predates presetNameSchema's
//     kebab-case rule must not poison the WHOLE bundle on re-import; it is
//     left out of `bundle.presets` and reported in
//     nonRoundTrippableImportDefinitions instead.
//   - StoreLocations are grouped into one traffic-store-mapping preset PER
//     REAL OWNER (via applyPreset.ts's currentTrafficStoreOwners), not
//     collapsed under one fixed name -- otherwise re-importing an export
//     would try to reclaim stores a differently-named CLI preset actually
//     owns and fail as an ownership conflict.
//
// Same in-memory-fake-Prisma approach as applyPreset.test.ts, trimmed to
// just the methods loadDbConfigState() and currentTrafficStoreOwners() call.

import { loadDbConfigState } from "@/lib/config/dbConfigState";
import { presetBundleSchema } from "@/lib/config/presetSchema";
import { TRAFFIC_STORE_MAPPING_PRESET_NAME } from "@/lib/config/presetApiTypes";

interface FakeDefinitionRow {
  id: number;
  name: string;
  description: string | null;
  targetEntity: string;
  sourceFormat: "CSV" | "XLSX";
  importMode: "INSERT_ONLY" | "UPSERT" | "RECONCILE";
  naturalKeyFields: string[];
  runnerKey: string | null;
  isActive: boolean;
  fieldMappings: Array<{ sourceColumn: string; targetField: string; transform: null; required: boolean }>;
  valueMappings: Array<{ targetField: string; sourceValue: string; targetValue: string }>;
}
interface FakeStoreRow {
  id: number;
  name: string;
  isActive: boolean;
  trafficSourceNames: string[];
}
interface FakeChangeLogRow {
  presetKind: string;
  presetName: string;
  action: string;
  summary: unknown;
  created: Date;
}

function createFakeDb(opts: {
  definitions?: FakeDefinitionRow[];
  stores?: FakeStoreRow[];
  changeLogs?: FakeChangeLogRow[];
}) {
  const definitions = opts.definitions ?? [];
  const stores = opts.stores ?? [];
  const changeLogs = opts.changeLogs ?? [];

  return {
    importDefinition: {
      findMany: jest.fn(async () => definitions),
    },
    storeLocation: {
      findMany: jest.fn(async () => stores),
    },
    trafficSnapshot: {
      findMany: jest.fn(async () => []),
    },
    configChangeLog: {
      // currentTrafficStoreOwners (applyPreset.ts) calls findMany with no
      // presetName filter -- newest first is all it needs from this fake.
      findMany: jest.fn(async ({ where }: { where: { presetKind: string; action?: { in: string[] } } }) => {
        let rows = changeLogs.filter((r) => r.presetKind === where.presetKind);
        if (where.action?.in) {
          const allowed = where.action.in;
          rows = rows.filter((r) => allowed.includes(r.action));
        }
        return [...rows].sort((a, b) => b.created.getTime() - a.created.getTime());
      }),
    },
    // Unused by loadDbConfigState/currentTrafficStoreOwners, but present so
    // this object structurally satisfies the PrismaClient shape callers
    // narrow to at the call site (cast below).
  } as never;
}

function definitionRow(overrides: Partial<FakeDefinitionRow> = {}): FakeDefinitionRow {
  return {
    id: 1,
    name: "acme-customers",
    description: null,
    targetEntity: "customer",
    sourceFormat: "CSV",
    importMode: "INSERT_ONLY",
    naturalKeyFields: [],
    runnerKey: null,
    isActive: true,
    fieldMappings: [],
    valueMappings: [],
    ...overrides,
  };
}

describe("loadDbConfigState — ImportDefinition name round-trip (item 7)", () => {
  it("includes a well-formed kebab-case definition in the bundle normally", async () => {
    const db = createFakeDb({ definitions: [definitionRow({ name: "acme-customers" })] });
    const state = await loadDbConfigState(db);

    expect(state.bundle.presets.some((p) => p.kind === "import-definition" && p.name === "acme-customers")).toBe(
      true,
    );
    expect(state.nonRoundTrippableImportDefinitions).toEqual([]);
  });

  it("leaves a non-kebab-case definition OUT of the bundle and reports it separately, instead of " +
    "poisoning the whole bundle's re-import", async () => {
      const db = createFakeDb({
        definitions: [
          definitionRow({ id: 1, name: "acme-customers" }),
          definitionRow({ id: 2, name: "Legacy Import (v1)" }), // predates presetNameSchema
        ],
      });
      const state = await loadDbConfigState(db);

      const names = state.bundle.presets
        .filter((p) => p.kind === "import-definition")
        .map((p) => p.name);
      expect(names).toEqual(["acme-customers"]); // the bad one is not in here
      expect(state.nonRoundTrippableImportDefinitions).toEqual([
        { name: "Legacy Import (v1)", reason: expect.any(String) },
      ]);

      // The load-bearing assertion: the returned bundle, as-is, survives the
      // SAME schema re-import validation the apply route runs. Before this
      // fix, a bundle containing "Legacy Import (v1)" would fail here and
      // take the well-formed "acme-customers" entry down with it.
      expect(presetBundleSchema.safeParse(state.bundle).success).toBe(true);
    },
  );
});

describe("loadDbConfigState — traffic-store-mapping ownership grouping (item 8)", () => {
  it("groups an unowned store (no ConfigChangeLog history) under the default GUI preset name", async () => {
    const db = createFakeDb({
      stores: [{ id: 1, name: "Downtown", isActive: true, trafficSourceNames: ["DT"] }],
      changeLogs: [],
    });
    const state = await loadDbConfigState(db);

    const traffic = state.bundle.presets.filter((p) => p.kind === "traffic-store-mapping");
    expect(traffic).toHaveLength(1);
    expect(traffic[0].name).toBe(TRAFFIC_STORE_MAPPING_PRESET_NAME);
    expect(traffic[0].kind === "traffic-store-mapping" && traffic[0].stores).toEqual([
      { storeLocation: "Downtown", sourceNames: ["DT"] },
    ]);
  });

  it("groups a store under its REAL current owner, not the fixed GUI name, when a differently-named " +
    "CLI preset owns it", async () => {
      const db = createFakeDb({
        stores: [
          { id: 1, name: "Downtown", isActive: true, trafficSourceNames: ["DT"] },
          { id: 2, name: "Uptown", isActive: true, trafficSourceNames: ["UT"] },
        ],
        changeLogs: [
          {
            presetKind: "traffic-store-mapping",
            presetName: "saybrook-traffic",
            action: "APPLIED",
            summary: { ownedStores: ["Downtown"] },
            created: new Date("2026-01-01"),
          },
          {
            presetKind: "traffic-store-mapping",
            presetName: TRAFFIC_STORE_MAPPING_PRESET_NAME,
            action: "APPLIED",
            summary: { ownedStores: ["Uptown"] },
            created: new Date("2026-01-02"),
          },
        ],
      });
      const state = await loadDbConfigState(db);

      const traffic = state.bundle.presets.filter(
        (p): p is Extract<typeof p, { kind: "traffic-store-mapping" }> => p.kind === "traffic-store-mapping",
      );
      const byName = Object.fromEntries(traffic.map((p) => [p.name, p.stores.map((s) => s.storeLocation)]));
      expect(byName["saybrook-traffic"]).toEqual(["Downtown"]);
      expect(byName[TRAFFIC_STORE_MAPPING_PRESET_NAME]).toEqual(["Uptown"]);

      // Load-bearing: re-importing this exact bundle must not conflict with
      // itself -- each store is claimed by exactly one preset name in it,
      // and that name matches who ConfigChangeLog says already owns it.
      expect(presetBundleSchema.safeParse(state.bundle).success).toBe(true);
    },
  );

  it("always includes the default GUI preset name in the bundle even with zero claimed stores " +
    "(stable shape for a fresh clone / empty deployment)", async () => {
      const db = createFakeDb({ stores: [{ id: 1, name: "Downtown", isActive: true, trafficSourceNames: [] }] });
      const state = await loadDbConfigState(db);

      const traffic = state.bundle.presets.filter((p) => p.kind === "traffic-store-mapping");
      expect(traffic).toHaveLength(1);
      expect(traffic[0].name).toBe(TRAFFIC_STORE_MAPPING_PRESET_NAME);
      expect(traffic[0].kind === "traffic-store-mapping" && traffic[0].stores).toEqual([]);
    },
  );
});
