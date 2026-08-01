// /app/src/lib/modules/index.ts
//
// Public surface of the module manifest. featureCatalog.ts, the Settings UI,
// and requireModule.ts all read the registry through these helpers rather
// than reaching into registry.ts directly, so "what counts as enabled" and
// "what's visible where" stay defined in exactly one place (rule 6/37).

import { MODULES } from "./registry";
import type { ModuleDef } from "./types";

export { MODULES } from "./registry";
export type {
  ModuleDef,
  ModuleCategory,
  ModuleSettingsDef,
  ModuleNavItem,
  SettingField,
  Role,
} from "./types";

const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export function isValidModuleKey(key: string): boolean {
  return MODULE_BY_KEY.has(key);
}

export function getModule(key: string): ModuleDef | undefined {
  return MODULE_BY_KEY.get(key);
}

// Resolve effective on/off exactly like featureCatalog's isFeatureEnabled: an
// explicit AppSettings value wins, otherwise the manifest default applies.
// Duplicated (rather than imported from featureCatalog) so this module has no
// dependency on the back-compat shim -- featureCatalog depends on this file,
// not the other way around.
export function isModuleOn(features: Record<string, boolean>, key: string): boolean {
  if (key in features) return features[key];
  return MODULE_BY_KEY.get(key)?.defaultEnabled ?? false;
}

// The modules a "Settings > Modules" toggle grid should offer. Core modules
// always appear, on or off. Addon modules (niche / single-tenant) only appear
// once already enabled -- so a deployment that doesn't have one can't
// discover and flip it on from the UI. Order matches the manifest.
export function getToggleableModules(features: Record<string, boolean>): ModuleDef[] {
  return MODULES.filter((m) => m.category === "core" || isModuleOn(features, m.key));
}

// The enabled modules worth a Settings sub-page: anything with `settings`
// and/or `nav` to show. A module with neither has nothing beyond its on/off
// switch, so it doesn't get an index entry or a route.
export function getModulesForSettingsIndex(features: Record<string, boolean>): ModuleDef[] {
  return MODULES.filter(
    (m) => isModuleOn(features, m.key) && (m.settings !== undefined || m.nav !== undefined),
  );
}

// A module is reachable at /admin/settings/[module] only when it's both
// enabled AND declares something to render -- the same rule the index above
// uses to decide whether to link to it in the first place.
export function isModuleSettingsRoutable(features: Record<string, boolean>, key: string): boolean {
  const mod = MODULE_BY_KEY.get(key);
  if (!mod) return false;
  if (!isModuleOn(features, key)) return false;
  return mod.settings !== undefined || mod.nav !== undefined;
}
