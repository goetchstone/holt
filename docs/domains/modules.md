# Module manifest

Single source of truth (CLAUDE.md rules 6/37) for every optional / tiered
module Holt ships: what it's called, whether it's on by default, whether it's
niche enough to hide from most deployments, what its own settings/nav/docs
are. Lives at `src/lib/modules/`.

## Why this exists

Before this, "a module" was three unrelated things that happened to share a
string key:

1. `lib/featureCatalog.ts` — `FEATURES`: key/name/description/defaultEnabled.
   Drove the Settings → Modules toggle grid and `isFeatureEnabled()`, called
   from ~25 files to gate routes (404 when off).
2. Hand-written `notFound()` / `res.status(404)` / `TRPCError` guards at each
   gated route, each re-deriving "is this module on" from `getAppSettings()` +
   `isFeatureEnabled()`.
3. Hand-added nav entries and a runbook, written separately and easy to skip.

Adding a module meant touching the catalog, gating each route by hand,
hand-adding nav, and writing a runbook — four uncoordinated edits, and nothing
enforced that a new module did all four. `lib/modules/registry.ts` collapses
those into one declaration per module; the rest of this doc is how to read it
and how to add to it.

## The shape (`src/lib/modules/types.ts`)

```ts
export type Role =
  | "SUPER_ADMIN" | "ADMIN" | "MANAGER" | "DESIGNER"
  | "REGISTER" | "WAREHOUSE" | "INSTALLER" | "MARKETING";

export type ModuleCategory = "core" | "addon";

export interface SettingField {
  key: string;
  label: string;
  type?: "text" | "number" | "boolean" | "color"; // default "text"
  placeholder?: string;
  min?: number;
  max?: number;
}

export interface ModuleSettingsDef {
  path: string;              // route segment under /admin/settings/[module]
  fields?: SettingField[];   // declarative -> renders generically
  custom?: boolean;          // escape hatch; NOT the default path (none use it)
}

export interface ModuleNavItem {
  label: string;
  href: string;
  roles?: Role[];             // omitted = public / no role restriction
}

export interface ModuleDef {
  key: string;                // SAME string as the pre-manifest feature-flag
                               // key. Never rename -- stored verbatim in
                               // AppSettings.features.
  name: string;
  description: string;
  defaultEnabled: boolean;
  category: ModuleCategory;
  settings?: ModuleSettingsDef;
  nav?: ModuleNavItem[];
  integrations?: string[];    // ids from lib/integrationCatalog.ts
  docs?: string;               // e.g. "docs/domains/dmarc-tools.md"
}
```

`MODULES: ModuleDef[]` (`src/lib/modules/registry.ts`) is the list itself —
one entry per module, `core` for the pre-existing 19, `addon` for `dmarcTools`
(see [Categories](#categories-core-vs-addon) below).

## Backwards compatibility

`lib/featureCatalog.ts` is now a thin shim: `FEATURES` is **derived** from
`MODULES` (`MODULES.map(({key, name, description, defaultEnabled}) => ...)`),
and `isFeatureEnabled()` / `isValidFeatureKey()` are unchanged. Every one of
the ~25 existing call sites (`grep -rn isFeatureEnabled src/`) keeps working
with zero edits — same signature, same resolution (explicit `AppSettings`
value wins, else the catalog default), same behavior. `__tests__/moduleManifest.test.ts`
pins this: it hardcodes the pre-refactor `(key, defaultEnabled)` list (copied
from the old `featureCatalog.ts`, not derived from `MODULES` — that would just
test the derivation against its own source) and asserts `FEATURES` still
matches it exactly, in order. A future edit that renames a key or flips a
default fails that test.

**Do not add fields to `FeatureDef` or hand-edit `FEATURES`.** Add to
`ModuleDef` / `MODULES` instead; the shim carries the four original fields
through automatically.

## The shared gate: `requireModule` / `isModuleEnabled`

`src/lib/modules/requireModule.ts` replaces the copy-pasted
`getAppSettings()` + `isFeatureEnabled()` pair that used to precede every
`notFound()` / `res.status(404)` / `TRPCError` gate (CLAUDE.md rule 42: one
shared guard on every path that needs it).

```ts
// App Router server-component pages: 404s (never returns) when off.
await requireModule("dmarcTools");

// Everywhere else (Pages Router API routes, tRPC procedures, other libs)
// that needs to shape its own response:
if (!(await isModuleEnabled("dmarcTools"))) {
  return res.status(404).json({ error: "Not found" });
}
```

Applied to every matching gate in this refactor: both DMARC pages, the DMARC
API route, the helpdesk/support pages, legacy-archive, the client portal, the
billing invoice pages, the billing/client-portal/legacy-archive tRPC
routers, the comments and legacy-POS-import API routes, and the generic
`feature` option on `requirePage()` / `withAuth()`. `lib/billing/billingReadiness.ts`
is the one deliberate holdout — it takes an explicit `orgId` for multi-org
readiness checks, and `isModuleEnabled()` always resolves the default org, so
it keeps its own `getAppSettings(orgId)` call.

## Categories: core vs. addon

- **`core`** — general business functions (warehousing, purchasing, billing,
  …). Always visible in the Settings → Modules toggle grid, on or off. This
  is every module that existed before this refactor; their visibility is
  unchanged.
- **`addon`** — niche / single-tenant. Hidden from the toggle grid **unless
  already enabled**, so a deployment that was never meant to have it can't
  discover and flip it on from the UI. `dmarcTools` is the one addon today:
  Akritos-only lead-gen tooling, provisioned via `scripts/seed-akritos.mjs`,
  not the Settings UI. A furniture retailer's toggle grid never shows it.

`getToggleableModules(features)` (`lib/modules/index.ts`) implements the
rule: `category === "core" || isModuleOn(features, key)`.

## Settings routes

- **`/admin/settings`** — overview. Branding, Theme, Localization, Booking
  (unchanged, not modularized — see [Design notes](#design-notes)), the
  Modules toggle grid, and a **Module settings** index: enabled modules that
  declare `settings` and/or `nav`, linking to `/admin/settings/[module]`.
  Disabled modules never appear here — `getModulesForSettingsIndex()` filters
  on `isModuleOn()` first. That's the nav-level expression of the same rule
  the 404 route guards enforce at the route level.
- **`/admin/settings/[module]`** — one module's settings, rendered generically
  from its `ModuleDef` (`ModuleSettingsView.tsx`): a "Pages" section from
  `nav`, a "Settings" section from `settings.fields` (see
  [the fields path](#the-fields-path-not-yet-load-bearing) below), a
  `docs` pointer. 404s (`isModuleSettingsRoutable()`) for an unknown key, a
  disabled module, or a module with neither `settings` nor `nav` — same rule
  the index uses to decide whether to link there, so the page isn't reachable
  by guessing a URL either.
- **`/admin/settings/integrations`** — moved out of the old monolithic
  Settings page (previously ~600 lines: Branding + Theme + Localization +
  Booking + Modules + Integrations stacked vertically on one route). Same
  `INTEGRATION_PROVIDERS` catalog, same `/api/admin/settings/integrations{,/test}`
  contract, unchanged behavior — just its own route now.

All three keep the `requirePage(["ADMIN"])` gate the old single page had.

## Adding a module: the checklist

1. Add an entry to `MODULES` in `lib/modules/registry.ts`: `key` (new, unique
   — this becomes the `AppSettings.features` key forever), `name`,
   `description`, `defaultEnabled`, `category`.
2. Gate its routes: `await requireModule("yourKey")` in App Router pages,
   `isModuleEnabled("yourKey")` in API routes / tRPC procedures / other libs.
3. If it has real settings, add `settings: { path, fields }` — declarative
   fields render generically (see caveat below). If it only links to its own
   pages, add `nav`.
4. Add `docs: "docs/domains/your-module.md"` and write that runbook.
5. If it's niche / single-tenant, set `category: "addon"` so it doesn't
   clutter every other deployment's toggle grid.
6. Run `__tests__/moduleManifest.test.ts` — extend the key-uniqueness / shape
   assertions if you added new invariants worth pinning.

That's it — one file, one route wiring, and the Settings UI, the toggle grid,
and the settings index all update themselves from step 1 onward.

## Design notes

### Branding/Theme/Localization/Booking are not modules

These four sections stayed on the `/admin/settings` overview page rather than
becoming manifest entries. Branding/Theme/Localization aren't gated modules at
all — always-on account configuration. Booking IS a module (`booking` key,
its own `FEATURES` entry, default on) with real configurable fields
(`windowDays`, `startHour`, `endHour`, `slotMinutes`) that could have become
the manifest's first `settings.fields` demo. It didn't, on purpose: those
fields save through `bookingConfig` on `AppSettings`, a typed column separate
from the flat `features` map, and building a generic fields-to-payload mapper
for a shape that has exactly one (pre-existing, differently-shaped) consumer
would have been speculative infrastructure ahead of a second real user. The
`SettingField` type exists and is ready; the persistence side is not built
until something other than a hypothetical needs it.

### The fields path is not yet load-bearing

`ModuleSettingsDef.fields` is fully typed and `ModuleSettingsView.tsx` will
render a field list generically if a module ever declares one — but no
shipped module does. `dmarcTools`, the first (and so far only) manifest-driven
module, has no configurable settings: it's the **"nav but no fields"** case,
not the fields case. Its settings page shows its `nav` links (out to
`/tools/dmarc-check` and `/tools/dmarc-report`) and its `docs` pointer, and
nothing else.

This is worth flagging rather than papering over: the `fields` path renders
read-only descriptors today (key/label/type), not live form controls wired to
a save endpoint, because there's nowhere to save them — `AppSettings` has no
generic per-module JSON bag, only the typed columns (`theme`, `features`,
`bookingConfig`) each section already used. Wiring real persistence (most
likely a `moduleSettings: Json` column + a small generic PUT endpoint) is
scoped to whichever future module is the first to actually need configurable
fields, not built speculatively here. Until then, `settings.fields` documents
intent more than it drives UI.

### `dmarcTools` — the first end-to-end module

```ts
{
  key: "dmarcTools",
  name: "Email Auth Tools (DMARC)",
  description:
    "Public DMARC / SPF / DKIM domain checker + aggregate-report analyzer. " +
    "Lead-gen consult tooling; off by default.",
  defaultEnabled: false,
  category: "addon",
  nav: [
    { label: "DMARC / SPF / DKIM Checker", href: "/tools/dmarc-check" },
    { label: "DMARC Report Analyzer", href: "/tools/dmarc-report" },
  ],
  docs: "docs/domains/dmarc-tools.md",
}
```

See `docs/domains/dmarc-tools.md` for the tool itself (unchanged). What
changed here: the two page gates (`/tools/dmarc-check`, `/tools/dmarc-report`)
and the API route gate (`/api/tools/dmarc-check`) now call
`requireModule("dmarcTools")` / `isModuleEnabled("dmarcTools")` instead of
each re-deriving the check, and its nav + runbook pointer are declared once,
in the registry, instead of living only in prose.
