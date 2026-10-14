// /app/src/lib/config/dbConfigState.ts
//
// Server-only: renders the LIVE database as a PresetBundle — the read side
// of "same schema, same rows, GUI is a peer of the config files"
// (docs/domains/config-presets.md). Used by both the presets GET route (the
// editors' data source) and the export route (the file-download path), so
// there is exactly one place that knows how an ImportDefinition row or a
// StoreLocation row becomes preset shape.
//
// Every ImportDefinition becomes its own `import-definition` preset, named
// after the row (1:1, since the DB already stores one row per definition).
// StoreLocations are grouped into one `traffic-store-mapping` preset PER
// REAL OWNER (see currentTrafficStoreOwners in applyPreset.ts) — a store
// with no ownership history falls back to TRAFFIC_STORE_MAPPING_PRESET_NAME,
// the GUI's own default identity (see that constant's comment in
// presetApiTypes.ts). This is not a collapse-to-one the way it used to be:
// once applyPreset.ts enforces one owner per store, rendering every store
// under a single fixed name would make the export unusable for a deployment
// whose CLI preset uses a different name (see the comment further down).
//
// This produces a PLAIN OBJECT typed as PresetBundle, not a zod-validated
// one. That is deliberate for everything EXCEPT the name: an
// ImportDefinition.description, targetEntity, mappings etc. that predate
// some later schema tightening should still be visible here for display —
// rejecting the whole row would make the GUI a worse mirror of the database
// than a raw SQL client. `name` is the one exception, because it is not just
// display content, it is the identity applyPreset.ts's find-by-name
// reconciliation keys on: a name that fails presetNameSchema (kebab-case --
// nothing enforces that at the DB level, and the GUI does not retroactively
// rename a pre-existing row) would make presetBundleSchema reject the ENTIRE
// bundle on re-import, one bad apple taking down every other definition and
// every traffic-store-mapping preset with it. Round-trip (export, or even
// just what the GUI itself last showed, back through POST .../apply) is a
// load-bearing promise, so a definition like that is left OUT of `bundle`
// and reported instead, in `nonRoundTrippableImportDefinitions` — visible
// enough to act on, but not able to break anyone else's re-import. The gate
// that actually MUST reject a non-conforming bundle is POST .../apply, right
// before it writes anything (see pages/api/admin/config/presets/apply.ts);
// this is a second, earlier line of defense specifically against the
// export/round-trip path.

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  nestValueMappings,
  presetNameSchema,
  PRESET_SCHEMA_VERSION,
  STOCK_LOCATION_TYPES,
} from "@/lib/config/presetSchema";
import type {
  ImportDefinitionPreset,
  PresetBundle,
  StockLocationsPreset,
  TrafficStoreMappingPreset,
} from "@/lib/config/presetSchema";
import { currentStoreOwners, currentTrafficStoreOwners } from "@/lib/config/applyPreset";
import {
  STOCK_LOCATIONS_PRESET_NAME,
  TRAFFIC_STORE_MAPPING_PRESET_NAME,
} from "@/lib/config/presetApiTypes";
import type { StoreLocationSummary } from "@/lib/config/presetApiTypes";

export interface DbConfigState {
  bundle: PresetBundle;
  storeLocations: StoreLocationSummary[];
  unmappedTrafficSourceNames: string[];
  /** ImportDefinition rows whose `name` fails presetNameSchema (not valid
   *  kebab-case) and were therefore left OUT of `bundle` — see the file
   *  header. The definition still exists and still runs; it just cannot be
   *  represented as a preset until it is renamed to a kebab-case name
   *  (which needs a code change today — nothing exposes an ImportDefinition
   *  rename). Empty on any deployment where every definition was created
   *  through applyPreset.ts, which is the common case. */
  nonRoundTrippableImportDefinitions: Array<{ name: string; reason: string }>;
}

function normalizeSourceName(name: string): string {
  // Matches the case-insensitive/trimmed matching lib/trafficStoreMap.ts
  // uses at read time, so "already claimed" here means the same thing it
  // means when a traffic import actually resolves a store.
  return name.trim().toLowerCase();
}

export async function loadDbConfigState(db: PrismaClient = defaultPrisma): Promise<DbConfigState> {
  const [definitions, storeLocations, distinctTraffic] = await Promise.all([
    db.importDefinition.findMany({
      include: {
        fieldMappings: { orderBy: { sortOrder: "asc" } },
        valueMappings: true,
      },
      orderBy: { name: "asc" },
    }),
    db.storeLocation.findMany({
      select: { id: true, name: true, isActive: true, trafficSourceNames: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.trafficSnapshot.findMany({
      distinct: ["sourceStoreName"],
      select: { sourceStoreName: true },
      orderBy: { sourceStoreName: "asc" },
    }),
  ]);

  const nonRoundTrippableImportDefinitions: Array<{ name: string; reason: string }> = [];
  const importDefinitionPresets: ImportDefinitionPreset[] = [];
  for (const def of definitions) {
    const nameCheck = presetNameSchema.safeParse(def.name);
    if (!nameCheck.success) {
      nonRoundTrippableImportDefinitions.push({
        name: def.name,
        reason: nameCheck.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    importDefinitionPresets.push({
      kind: "import-definition",
      name: def.name,
      description: def.description ?? undefined,
      targetEntity: def.targetEntity,
      sourceFormat: def.sourceFormat,
      importMode: def.importMode,
      naturalKeyFields: def.naturalKeyFields,
      runnerKey: def.runnerKey ?? undefined,
      isActive: def.isActive,
      fieldMappings: def.fieldMappings.map((fm) => ({
        sourceColumn: fm.sourceColumn,
        targetField: fm.targetField,
        transform: fm.transform ?? undefined,
        required: fm.required,
      })),
      valueMappings: nestValueMappings(
        def.valueMappings.map((vm) => ({
          targetField: vm.targetField,
          sourceValue: vm.sourceValue,
          targetValue: vm.targetValue,
        })),
      ),
    });
  }

  // Grouped by each store's REAL current owner (per ConfigChangeLog), not
  // collapsed under one fixed name. applyPreset.ts now enforces "a store may
  // be claimed by only one traffic-store-mapping preset at a time"
  // (docs/domains/config-presets.md, "Ownership") — exporting every store
  // under TRAFFIC_STORE_MAPPING_PRESET_NAME regardless of who actually owns
  // it would make the export unusable for any deployment whose CLI preset
  // uses a different name: re-importing it would try to reclaim stores that
  // preset never owns and fail the whole traffic-store-mapping apply as a
  // conflict, even though nothing substantive changed. A store with no
  // ownership history at all (trafficSourceNames set some other way — a
  // direct write, an old fixture) falls back to
  // TRAFFIC_STORE_MAPPING_PRESET_NAME, the GUI's own default identity,
  // which is as good a home for genuinely-unowned data as any.
  const claimedStores = storeLocations.filter((s) => s.trafficSourceNames.length > 0);
  const owners = await currentTrafficStoreOwners(
    db,
    claimedStores.map((s) => s.name),
  );
  const storesByOwner = new Map<string, StoreLocationSummary[]>();
  storesByOwner.set(TRAFFIC_STORE_MAPPING_PRESET_NAME, []);
  for (const s of claimedStores) {
    const owner = owners.get(s.name) ?? TRAFFIC_STORE_MAPPING_PRESET_NAME;
    const list = storesByOwner.get(owner);
    if (list) list.push(s);
    else storesByOwner.set(owner, [s]);
  }
  // Deterministic order — the GUI's own default name first (the common
  // case, and what every deployment saw before this preset could exist),
  // then every other real owner alphabetically — so re-exporting unchanged
  // config stays a byte-identical, non-spurious diff.
  const ownerNames = [...storesByOwner.keys()].sort((a, b) => {
    if (a === TRAFFIC_STORE_MAPPING_PRESET_NAME) return -1;
    if (b === TRAFFIC_STORE_MAPPING_PRESET_NAME) return 1;
    return a.localeCompare(b);
  });
  const trafficPresets: TrafficStoreMappingPreset[] = ownerNames.map((name) => ({
    kind: "traffic-store-mapping",
    name,
    stores: (storesByOwner.get(name) ?? []).map((s) => ({
      storeLocation: s.name,
      sourceNames: s.trafficSourceNames,
    })),
  }));

  const stockLocationPresets = await loadStockLocationPresets(db);

  const bundle: PresetBundle = {
    version: PRESET_SCHEMA_VERSION,
    presets: [...importDefinitionPresets, ...trafficPresets, ...stockLocationPresets],
  };

  const claimed = new Set(
    storeLocations.flatMap((s) => s.trafficSourceNames.map(normalizeSourceName)),
  );
  const unmappedTrafficSourceNames = distinctTraffic
    .map((r) => r.sourceStoreName)
    .filter((name) => !claimed.has(normalizeSourceName(name)))
    .sort((a, b) => a.localeCompare(b));

  return { bundle, storeLocations, unmappedTrafficSourceNames, nonRoundTrippableImportDefinitions };
}

type StockLocationEntry = StockLocationsPreset["stores"][number]["locations"][number];

/** One database place -> a preset entry, with unset optional fields left out. */
function toStockLocationEntry(p: {
  code: string;
  name: string;
  description: string | null;
  locationType: string;
  building: string | null;
  floor: number | null;
  area: number | null;
  squareFootage: number | null;
  locationAliases: string[];
  holdsCommittedStock: boolean;
  sortOrder: number;
}): StockLocationEntry {
  return {
    code: p.code,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    locationType: p.locationType as StockLocationEntry["locationType"],
    ...(p.building ? { building: p.building } : {}),
    ...(p.floor === null ? {} : { floor: p.floor }),
    ...(p.area === null ? {} : { area: p.area }),
    ...(p.squareFootage === null ? {} : { squareFootage: p.squareFootage }),
    aliases: p.locationAliases,
    holdsCommittedStock: p.holdsCommittedStock,
    ...(p.sortOrder ? { sortOrder: p.sortOrder } : {}),
  };
}

/**
 * Every store's active places, as stock-locations presets -- how a
 * deployment's real layout gets out of the database and into a reviewable
 * file (config/local/), and back into a rebuilt database with apply-preset.
 *
 * Grouped under each store's current owning preset, or the default name for a
 * store no preset has claimed, like traffic-store-mapping above. A place whose
 * type the preset schema does not know is left out and logged rather than
 * exported as something a re-import would refuse.
 */
async function loadStockLocationPresets(db: PrismaClient): Promise<StockLocationsPreset[]> {
  const places = await db.stockLocation.findMany({
    where: { isActive: true },
    orderBy: [{ storeLocation: { name: "asc" } }, { code: "asc" }],
    select: {
      code: true,
      name: true,
      description: true,
      locationType: true,
      building: true,
      floor: true,
      area: true,
      squareFootage: true,
      locationAliases: true,
      holdsCommittedStock: true,
      sortOrder: true,
      storeLocation: { select: { name: true } },
    },
  });

  const byStore = new Map<string, StockLocationsPreset["stores"][number]["locations"]>();
  for (const p of places) {
    if (!(STOCK_LOCATION_TYPES as readonly string[]).includes(p.locationType)) {
      logger.warn("Stock location left out of the preset export: unknown locationType", {
        store: p.storeLocation.name,
        code: p.code,
        locationType: p.locationType,
      });
      continue;
    }
    const list = byStore.get(p.storeLocation.name) ?? [];
    list.push(toStockLocationEntry(p));
    byStore.set(p.storeLocation.name, list);
  }

  const storeNames = [...byStore.keys()];
  const owners = await currentStoreOwners(db, "stock-locations", storeNames);
  const storesByOwner = new Map<string, StockLocationsPreset["stores"]>();
  for (const storeName of storeNames) {
    const owner = owners.get(storeName) ?? STOCK_LOCATIONS_PRESET_NAME;
    const list = storesByOwner.get(owner) ?? [];
    list.push({ storeLocation: storeName, locations: byStore.get(storeName) ?? [] });
    storesByOwner.set(owner, list);
  }
  return [...storesByOwner.keys()]
    .sort((a, b) => {
      if (a === STOCK_LOCATIONS_PRESET_NAME) return -1;
      if (b === STOCK_LOCATIONS_PRESET_NAME) return 1;
      return a.localeCompare(b);
    })
    .map((name) => ({
      kind: "stock-locations" as const,
      name,
      stores: storesByOwner.get(name) ?? [],
    }));
}
