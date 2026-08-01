// /app/src/lib/featureCatalog.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for optional / tiered
// modules. AppSettings.features is a { [key]: boolean } map; both the Settings
// UI and any server-side gate validate keys against this list. Core modules
// (catalog, sales, customers, reporting) are always on and are NOT listed here
// -- only the modules a plan can switch off appear.
//
// This is now a thin back-compat shim over lib/modules/registry.ts, THE
// module manifest (docs/domains/modules.md). FEATURES is derived from
// MODULES rather than hand-duplicated, so the two can never drift -- but the
// exported shape (FeatureDef, FEATURES, isValidFeatureKey, isFeatureEnabled)
// is unchanged, and every existing call site (25 files, grep -rn
// isFeatureEnabled src/) keeps working with no edits. Do not add fields here;
// add them to ModuleDef in lib/modules/types.ts instead.

import { MODULES } from "./modules/registry";

export interface FeatureDef {
  key: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
}

export const FEATURES: FeatureDef[] = MODULES.map(({ key, name, description, defaultEnabled }) => ({
  key,
  name,
  description,
  defaultEnabled,
}));

const FEATURE_KEYS = new Set(FEATURES.map((f) => f.key));

export function isValidFeatureKey(key: string): boolean {
  return FEATURE_KEYS.has(key);
}

// Resolve effective on/off for a feature: an explicit AppSettings value wins,
// otherwise the catalog default applies.
export function isFeatureEnabled(features: Record<string, boolean>, key: string): boolean {
  if (key in features) return features[key];
  return FEATURES.find((f) => f.key === key)?.defaultEnabled ?? false;
}
