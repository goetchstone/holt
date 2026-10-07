// /app/src/lib/modules/types.ts
//
// The ModuleDef contract -- see docs/domains/modules.md for the full picture.
// One module declaration replaces what used to be spread across
// featureCatalog.ts (on/off), hand-written route guards, hand-added nav
// entries, and a runbook nobody was forced to update. `key` is a feature-flag
// key (lib/featureCatalog.ts) FIRST: it round-trips through AppSettings.features
// exactly as before, so renaming one here is a data migration, not a refactor.

// Mirrors the Prisma `StaffRole` enum (prisma/schema.prisma). Kept as a plain
// union here rather than importing the Prisma type so this file has no
// dependency on the generated client -- it's pure metadata, read by both
// server and client code (rule 7).
export type Role =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "MANAGER"
  | "DESIGNER"
  | "REGISTER"
  | "WAREHOUSE"
  | "INSTALLER"
  | "MARKETING";

export type ModuleCategory = "core" | "addon";

// Declarative settings field, deliberately shaped like
// lib/integrationCatalog.ts's IntegrationFieldDef -- the pattern that already
// renders generically. `type` selects the input control; omitted = "text".
export interface SettingField {
  key: string;
  label: string;
  type?: "text" | "number" | "boolean" | "color";
  placeholder?: string;
  min?: number;
  max?: number;
}

export interface ModuleSettingsDef {
  // Route segment under /admin/settings/[module]. By convention this is the
  // module key, but kept explicit rather than implied.
  path: string;
  // Declarative fields render generically via the shared settings-field
  // renderer -- prefer this over a custom component.
  fields?: SettingField[];
  // Escape hatch for a module whose settings genuinely can't be expressed as
  // a flat field list. NOT the default path: as of this writing no module
  // sets it, and adding one should be rare enough to justify a design review,
  // not a routine choice. See docs/domains/modules.md.
  custom?: boolean;
}

export interface ModuleNavItem {
  label: string;
  href: string;
  // Omitted = public / no role restriction (the DMARC tools are public
  // lead-gen pages). When set, mirrors the `roles` a page passes to
  // requirePage/CardGrid.
  roles?: Role[];
}

export interface ModuleDef {
  // SAME string as the pre-manifest feature-flag key. Never rename -- it is
  // stored verbatim in AppSettings.features and referenced by isFeatureEnabled
  // call sites that don't (and shouldn't need to) know a manifest exists.
  key: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  // "core" modules are always visible in the Settings > Modules toggle grid,
  // on or off -- they're general business functions a deployment turns on
  // when it needs them. "addon" modules are niche / single-tenant and are
  // hidden from that toggle grid unless already enabled, so a deployment that
  // was never meant to have them (a furniture retailer, for dmarcTools) never
  // even sees the option. Provisioning an addon module is a seed/DB change,
  // not a UI discovery.
  category: ModuleCategory;
  // Renders /admin/settings/[module] when present. Optional: a module with
  // nothing to configure doesn't need one.
  settings?: ModuleSettingsDef;
  // Surfaces this module's own routes (public pages, dashboard sub-pages,
  // whatever). Optional. Also gates whether the module gets an entry in the
  // Settings module index -- a module with neither `settings` nor `nav` has
  // nothing to navigate to beyond its on/off switch.
  nav?: ModuleNavItem[];
  // Provider ids (lib/integrationCatalog.ts INTEGRATION_PROVIDERS) this
  // module depends on, for cross-linking from its settings page. Optional.
  integrations?: string[];
  // Path to this module's runbook, e.g. "docs/domains/dmarc-tools.md".
  docs?: string;
}
