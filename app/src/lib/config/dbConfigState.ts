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
// All StoreLocations collapse into ONE `traffic-store-mapping` preset named
// TRAFFIC_STORE_MAPPING_PRESET_NAME — see that constant's comment in
// presetApiTypes.ts for why there is exactly one, not one per store.
//
// This produces a PLAIN OBJECT typed as PresetBundle, not a zod-validated
// one. That is deliberate: an ImportDefinition.name that predates
// presetNameSchema's kebab-case rule (or was written directly to the DB by
// something other than applyPreset) should still be visible here for
// display and export — rejecting it would make the GUI a worse mirror of
// the database than a raw SQL client. The gate that actually MUST reject a
// non-conforming bundle is POST .../apply, right before it writes anything
// (see pages/api/admin/config/presets/apply.ts).

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { nestValueMappings, PRESET_SCHEMA_VERSION } from "@/lib/config/presetSchema";
import type { ImportDefinitionPreset, PresetBundle, TrafficStoreMappingPreset } from "@/lib/config/presetSchema";
import { TRAFFIC_STORE_MAPPING_PRESET_NAME } from "@/lib/config/presetApiTypes";
import type { StoreLocationSummary } from "@/lib/config/presetApiTypes";

export interface DbConfigState {
  bundle: PresetBundle;
  storeLocations: StoreLocationSummary[];
  unmappedTrafficSourceNames: string[];
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
      distinct: ["axperStoreName"],
      select: { axperStoreName: true },
      orderBy: { axperStoreName: "asc" },
    }),
  ]);

  const importDefinitionPresets: ImportDefinitionPreset[] = definitions.map((def) => ({
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
  }));

  const trafficPreset: TrafficStoreMappingPreset = {
    kind: "traffic-store-mapping",
    name: TRAFFIC_STORE_MAPPING_PRESET_NAME,
    stores: storeLocations
      .filter((s) => s.trafficSourceNames.length > 0)
      .map((s) => ({ storeLocation: s.name, sourceNames: s.trafficSourceNames })),
  };

  const bundle: PresetBundle = {
    version: PRESET_SCHEMA_VERSION,
    presets: [...importDefinitionPresets, trafficPreset],
  };

  const claimed = new Set(
    storeLocations.flatMap((s) => s.trafficSourceNames.map(normalizeSourceName)),
  );
  const unmappedTrafficSourceNames = distinctTraffic
    .map((r) => r.axperStoreName)
    .filter((name) => !claimed.has(normalizeSourceName(name)))
    .sort((a, b) => a.localeCompare(b));

  return { bundle, storeLocations, unmappedTrafficSourceNames };
}
