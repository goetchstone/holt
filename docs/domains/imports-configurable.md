# Configurable Imports (Stage 1)

Declarative, no-code CSV/XLSX importer definitions — the mechanism behind
the README's promise ("CSV column mappings; vendor/POS formats ship as
reusable presets"), which did not exist before this stage. This doc covers
what Stage 1 actually built. For the existing hand-coded Ordorite/POS
pipeline (still the live path for every production import today), see
`imports-overview.md` and `import-pipeline.md` — this doc doesn't replace
either of those yet.

## Why this exists

Before Stage 1, every new data source meant a new hand-coded admin page plus
a new server-side runner (14 of them under
`app/src/app/(dashboard)/app/admin/import/`, plus a handful more for
pricing/gift-cards/pos-import). Adding a source required writing code. The
motivating symptom: `lib/adapters/ordorite/shared.ts::resolvePaymentMode`
hardcodes Ordorite's numeric payment codes to display strings ("Card
Connect", "Credit Note", ...), which then land **verbatim** in
`Payment.paymentType` — a free-text column. Native payments instead derive
`paymentType` from the bounded `PaymentMethod` enum via `METHOD_DISPLAY`
(`lib/paymentService.ts`). So imported data introduces payment-type strings
native code never produces, and `journalEntry.ts`'s `paymentGlMap` lookup
silently skips every row it doesn't recognize (see the "Unmapped payment
type" warning around `lib/journalEntry.ts:740`). That's a value-mapping
problem, not a code problem, and hardcoding it again in a second source
would just move the hardcoding.

## The core insight: export semantics, not "some importers are weird"

The axis that decides whether an importer can be pure config is **the
source's export semantics**, not how the CSV happens to be shaped:

- **DELTA / one-time dump** — each row is a fact to insert or upsert.
  Vendors, customers, categories, departments, types, products, inventory
  snapshots, and any well-behaved sales export are this shape. **Pure
  mapping. No code.**
- **FULL-STATE re-export** — each file asserts "this is everything as of
  now," so the importer must diff against what's already in the database:
  detect lines that vanished, orders that were rewritten, rows that went to
  zero. **This requires reconciliation logic that declarative config cannot
  express.**

Ordorite is the full-state kind, and that single fact — not "sales data is
special" — explains every quirk documented in `import-pipeline.md`:
same-day rewrite chains, orphan line cleanup, zero-quantity-means-cancelled,
the consignment wash. None of those are inherent to sales data; a vendor
that emitted deltas (most systems do) would need none of them.

**This is the honest boundary, stated plainly: config handles delta
sources; full-state sources need a reconciler.** Whoever adds a new import
definition should ask one question first — "does this file describe
changes, or does it describe everything?" — and that answer alone tells
them whether they're done after filling out a form or whether they need a
registered runner.

## The model

Three additive tables (migration
`prisma/migrations/20260801120000_add_configurable_imports/`), no changes to
any existing column:

```
ImportDefinition
  name, description
  targetEntity      -- string key into IMPORT_ENTITIES (genericImport.ts)
  sourceFormat      -- CSV | XLSX
  importMode        -- INSERT_ONLY | UPSERT | RECONCILE
  naturalKeyFields   -- String[]; which mapped target fields identify an
                        existing record, for UPSERT matching
  vendorId           -- optional owning vendor (vendor/POS-specific presets)
  runnerKey           -- optional code-backed escape hatch (see below)
  isActive
  fieldMappings  ImportFieldMapping[]
  valueMappings  ImportValueMapping[]

ImportFieldMapping
  definitionId, sourceColumn, targetField, transform, required, sortOrder

ImportValueMapping
  definitionId, targetField, sourceValue, targetValue
```

`targetEntity` deliberately has no foreign key — entities are defined in
code (`app/src/lib/genericImport.ts`'s `IMPORT_ENTITIES`), not in the
database, so a definition can only ever target an entity the app actually
knows how to receive.

`importMode` governs whether `runnerKey` is required:

| importMode    | runnerKey    | naturalKeyFields              | Who owns row processing                                                        |
| ------------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------ |
| `INSERT_ONLY` | optional     | unused                        | the generic engine                                                             |
| `UPSERT`      | optional     | **required**, ≥1 entry        | the generic engine (or a runner, if one is set — see "customer/product" below) |
| `RECONCILE`   | **required** | optional (documentation only) | the registered runner                                                          |

Enforced twice, on purpose:

1. **`validateImportDefinition`** (`app/src/lib/imports/validation.ts`) — a
   pure, friendly pre-flight check. Call this before writing a definition.
2. **`ImportDefinition_reconcile_requires_runner`** — a `CHECK` constraint
   added by hand in the migration (schema.prisma has no `@@check`
   annotation in this Prisma version, so this isn't expressed in the schema
   file itself — same as the existing `JournalEntry_balanced_check`
   precedent). A raw write or a future bug cannot bypass it.

## The transform set

Six, on purpose — small enough to read in one sitting, each earning its
place from a real need rather than a hypothetical one. Add a seventh only
for a concrete importer that needs it, with the justification recorded next
to it in `app/src/lib/imports/transforms.ts`.

| Transform   | What it does                                                                                    | Why it earns its place                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRIM`      | strips leading/trailing whitespace                                                              | Every hand-exported CSV this codebase has seen pads or misaligns at least one column; stray whitespace silently breaks exact-match value mapping and natural-key equality.                                             |
| `UPPERCASE` | uppercases (after trimming)                                                                     | Canonicalizes casing for state codes, SKUs, or status-like strings before they're used as a natural key or compared elsewhere.                                                                                         |
| `LOWERCASE` | lowercases (after trimming)                                                                     | Same, the other direction — emails, slugs.                                                                                                                                                                             |
| `NUMBER`    | generic numeric coercion                                                                        | The declarative-config analogue of `importHelpers.safeFloat` — quantities, counts, plain numeric fields.                                                                                                               |
| `DATE`      | generic date coercion → ISO string                                                              | The declarative-config analogue of `importHelpers.safeDate`. ISO output keeps a JSON preview payload safe and hands straight to a Prisma `DateTime` field.                                                             |
| `CURRENCY`  | money-specific numeric coercion: strips `$` and thousands separators, treats `(50.00)` as `-50` | Kept **separate from `NUMBER`** deliberately: applying parenthesis-as-negative to an ordinary quantity or count column would be wrong, and `NUMBER` staying naive keeps its behavior predictable for non-money fields. |

Order of operations is fixed and is the whole contract of
`runImportEngine` (`app/src/lib/imports/engine.ts`):

1. **field mapping** — pick the raw source column value off the row
2. **value mapping** — translate a raw source value onto the target's
   bounded vocabulary, _if_ this field has any value mappings configured
3. **transform** — trim/case/number/date/currency coercion
4. **required check** — once per row, after every field is resolved

## Unmapped values are never a silent pass-through

This is the specific failure mode the whole stage exists to close. If a
target field has **any** `ImportValueMapping` rows configured, every row's
raw value for that field must match one of them. A value present in the
file but absent from the configured set:

- is **not** written to the normalized record (the raw, untranslated string
  never reaches the target field)
- is recorded as a row-level error (`Unmapped value "X" for field "Y"`)
- is aggregated into `EngineRunResult.unmappedValues` — one entry per
  distinct `(targetField, sourceValue)` pair, with an occurrence count and
  up to 20 row indexes, so an operator reviewing a dry run sees "these 3
  values showed up and aren't mapped yet" rather than discovering it row by
  row (or, worse, not discovering it at all — the old failure mode).

A field with **no** value mappings configured is unaffected — its value
passes through (after transform) exactly as before. Value mapping is opt-in
per field, not a blanket requirement.

## Dry-run / preview

`runImportEngine` **is** the dry run. It performs no I/O and writes
nothing, so calling it against a sample of rows produces the exact
`would-create` / `would-update` / `skipped` / `error` breakdown an operator
would see before an import actually commits, plus the unmapped-value
summary above. There's no separate "preview" function — the pure engine's
only output _is_ a preview until some caller decides to act on it.

Row classification:

- **`skipped`** — every mapped source column was blank on this row
  (trailing blank CSV lines, etc.). Not treated as a validation failure —
  there was nothing to import.
- **`error`** — an unmapped value, a transform failure, a missing required
  field, or (for `UPSERT`/`RECONCILE`) an unresolvable natural key.
- **`would-create`** / **`would-update`** — for `INSERT_ONLY`, every valid
  row is `would-create` (there's no update concept). For `UPSERT` /
  `RECONCILE`, the engine joins the row's `naturalKeyFields` values into one
  key and checks it against `existingNaturalKeys`, a `ReadonlySet<string>`
  the **caller** supplies after querying Prisma — the engine itself never
  touches the database. Omit it and every row previews as `would-create`.

For a `RECONCILE` definition, this classification is a **best-effort
mapping-level preview only** — the registered runner may still
create/update/cancel differently once it actually reconciles against
existing data (a same-day rewrite, for instance, cancels lines the generic
engine has no way to know about from mapping alone).

## The code-backed escape hatch

Declarative config cannot express everything. Multi-pass logic (same-day
rewrite cleanup), cross-entity reconciliation (the consignment wash), and
domain rules that depend on more than one row (zero-quantity-means-
cancelled) need code — that's exactly the `RECONCILE` case above.

`ImportDefinition.runnerKey` names a runner registered in
`app/src/lib/imports/runnerRegistry.ts` — **a compile-time switch over a
flat catalog**, the same pattern as `lib/payments/index.ts`, not dynamic
loading:

```ts
const RUNNERS: Record<string, ImportRunner> = {
  customer: runCustomerRunner,
  product: runProductRunner,
};
```

A registered runner receives the definition's field and value mappings
(`ImportRunnerContext`) and owns row processing end to end, returning the
same `GenericImportResult` shape every import path already returns.
`getImportRunner(key)` throws a readable error for an unregistered key
rather than returning `undefined`.

### The seam is proven by a real consumer, not a toy

`customer` and `product` are registered runners
(`app/src/lib/imports/runners/customerRunner.ts`,
`.../productRunner.ts`) — thin adapters that convert a definition's
`FieldMappingInput[]` into the `ColumnMapping` shape
`genericImportRunner.ts`'s existing `runGenericImport` already expects, and
delegate. **Behavior is byte-for-byte unchanged**: this is an adapter, not a
rewrite, and `genericImportRunner.ts` itself was not modified.

Worth being precise about _why_ these two carry a `runnerKey`: they are
`UPSERT`-mode (delta sources, matched by external id / name+email), **not**
`RECONCILE`. A `runnerKey` isn't required for `UPSERT` — but it's allowed,
and customer/product show why an operator would still want one:
`findOrCreateCustomer`'s cascading dedup (external id, then trusted
email+name, then name alone, with late-hydration of stub records) and
`importProducts`' vendor/department/category auto-create-with-cache logic
predate this model, and reusing them through the escape hatch is cheaper
right now than reimplementing that logic as pure config. **`runnerKey` is
available to any `importMode`, not only `RECONCILE`** — `RECONCILE` is just
the one mode that can't function _without_ it.

Note: these two adapters do **not** apply value mappings before delegating
— none of the customer/product entity fields (`genericImport.ts`) are
configured with a bounded target vocabulary today, so there's nothing to
translate. A future runner whose fields _do_ need value-mapping should call
`lib/imports/engine.ts`'s value-mapping step explicitly rather than
skipping it the way these two do.

## Proof on the motivating case: Ordorite payment modes

`app/src/lib/imports/data/ordoritePaymentMode.ts` is **data, not code** —
the value-mapping set for the eight payment modes named in the Stage 1
brief:

| Ordorite display string (`resolvePaymentMode` output) | → holt `PaymentMethod` |
| ----------------------------------------------------- | ---------------------- |
| Card Connect                                          | `CARD`                 |
| Card Not Present                                      | `CARD`                 |
| Debit                                                 | `CARD`                 |
| Credit Note                                           | `STORE_CREDIT`         |
| Marketing                                             | `OTHER`                |
| Refund                                                | `OTHER`                |
| Charity                                               | `OTHER`                |
| Other                                                 | `OTHER`                |

`__tests__/imports/ordoritePaymentMode.test.ts` runs this exact data
through `runImportEngine` and asserts every one of the eight rows lands on
holt's bounded `PaymentMethod` vocabulary, and that a ninth, unseeded value
("Cryptocurrency") is reported as an unmapped-value error rather than
passed through. `prisma/seed/ordoritePaymentMode.ts` persists the same data
as a real (but `isActive: false`) `ImportDefinition` row, following the
existing `prisma/seed/*.ts` convention — idempotent, not executed as part
of this stage's verification.

**What Stage 1 does NOT do, stated plainly:** the live Ordorite
sales/payments runner (`lib/adapters/ordorite/runners.ts`) and
`resolvePaymentMode` (`lib/adapters/ordorite/shared.ts`) are **completely
unchanged**. `Payment.paymentType` on every existing and newly-imported row
still comes from the hardcoded `PAYMENT_MODE_MAP`. This section exists to
prove the mechanism works, not to ship it — wiring it into the live path,
and by extension migrating any of the 14 hand-coded importers, is Stage 3
territory. Ordorite is also `RECONCILE`-shaped (full-state re-export), so
that migration is not "point the sales runner at a value-mapping table" —
it needs `runnerKey`-backed reconciliation logic that still consumes the
definition's mappings, exactly the pattern customer/product already prove.

## How someone adds a definition

**Stage 3 has started.** `department` is the first entity migrated onto the
configurable path, and it is the proof that adding one is small: an entry in
`IMPORT_ENTITIES`, a writer in `genericImportRunner.ts`, and a three-line runner
in `lib/imports/runners/`. The fixed-shape REST route
(`pages/api/departments/import.ts`) now DELEGATES to that same writer instead of
carrying its own upsert, so both doors import a department identically — the
point of migrating rather than adding. A test asserts neither door can grow its
own `prisma.department` write again.

The remaining hand-coded importers follow the same three steps.

**Stage 2 update:** definitions no longer have to be written as Prisma calls
in a seed script. A definition is now authored either as a `config/` preset
(YAML or JSON, reviewable in a pull request) or in the admin UI, and applied
idempotently — see `config-presets.md`. Stage 3, migrating the 14 hand-coded
importers onto the engine, is still outstanding.

The decisions below are unchanged; only step 4 has an easier answer now.

1. Decide the `importMode` by asking: does the source file describe
   _changes_ (delta / one-time dump) or does it describe _everything as of
   now_ (full-state re-export)? The former is `INSERT_ONLY`/`UPSERT`; the
   latter is `RECONCILE`.
2. For `UPSERT`, decide which mapped target field(s) uniquely identify an
   existing record — that's `naturalKeyFields`.
3. For `RECONCILE`, write and register a runner
   (`app/src/lib/imports/runnerRegistry.ts`) before the definition can pass
   validation.
4. Write the definition as a preset — `kind: import-definition` in a file
   under `config/presets/` (ships with the product) or `config/local/`
   (gitignored, this deployment only) — and apply it with
   `node app/scripts/apply-preset.mjs`. Field mappings are a list; value
   mappings are a nested map keyed by target field, so you write the field
   name once rather than on every row. The admin UI writes the same rows and
   exports back to the same file format. Creating the rows directly in Prisma
   still works and is what the preset does under the hood.
5. Call `validateImportDefinition` before writing — it rejects a
   `RECONCILE` definition with no `runnerKey` and an `UPSERT` definition
   with no `naturalKeyFields`.
6. Preview it: `POST /api/admin/imports/preview` with `{ definitionId, rows }`
   returns the would-create/would-update/skipped/error breakdown and the
   unmapped-value summary for a sample, writing nothing. That endpoint is
   `runImportEngine`'s caller — until it existed, step 6 was a thing the design
   described and nobody could do, which is the difference between "holt is
   configurable" and "someone other than its author can configure it".

   It previews an INACTIVE definition too, deliberately: a definition ships
   inactive precisely while its mappings are still being worked out, so
   refusing would withhold the tool exactly when it is most needed. It does not
   supply `existingNaturalKeys`, so every valid UPSERT/RECONCILE row previews as
   `would-create` — answering "do my mappings work" does not need the target
   table, and a read-only endpoint should not query data it has no reason to.
   Rows are capped at 500 and truncation is reported, never silent.

7. Activate it and run it: `POST /api/admin/imports/run` with
   `{ definitionId, rows }` dispatches through the runner registry and writes.
   Gated MANAGER/ADMIN — the same gate as the hand-coded import routes, because
   this moves the same data through a different door. `admin.config` governs
   AUTHORING a definition; running one is a data import.

   Where it deliberately differs from preview: it REFUSES an inactive
   definition (otherwise `isActive` is decorative), and it REFUSES a definition
   with no `runnerKey` rather than falling back to the engine — the engine is a
   planner and writes nothing, so importing "through" it would report
   `imported: N` for rows nothing persisted, which looks like success. An
   oversized file is refused rather than truncated, for the same reason in
   reverse: a truncated import drops data and reports success for the rest.

   Every run is logged with the definition, row counts and the operator's
   email. The hand-coded routes leave no such trace, so a configured import is
   now more accountable than the code it replaces.

## The honest boundary — what config can and cannot express

**Config handles delta sources; full-state sources need a reconciler.**
More specifically, declarative config (field mapping + value mapping +
the six transforms + a natural key) can express:

- Renaming/reshaping arbitrary CSV columns onto a fixed entity's fields
- Coercing types (trim, case, number, date, currency)
- Translating a source system's vocabulary onto holt's bounded vocabulary
  (the Ordorite payment-mode case)
- Insert-vs-update classification by a natural key, for sources where "the
  same row reappearing" means "this is the current state of that record"

Config **cannot** express, and Stage 1 does not pretend it can:

- **Multi-pass / cross-row logic** — same-day rewrite cleanup needs to look
  at a base order, its rewrite, and a same-day return together before
  deciding which lines to cancel. No single row carries enough information.
- **Cross-entity reconciliation** — the consignment wash reconciles sales
  lines against consignment items across two different tables.
- **Domain rules that redefine what a row means** — zero-quantity-means-
  cancelled isn't a transform on one field, it's a rule about what the
  _absence_ of a positive quantity means for the record's lifecycle status.
- **Diffing against prior state** — "this file is everything as of now, so
  anything missing from it must have been removed" requires querying what
  currently exists and comparing, which is exactly what `RECONCILE` +
  `runnerKey` hands off to code.

If a genuinely delta-shaped source (one that always describes changes, not
full state) turns out to need a runner anyway, that's a real gap in the
config surface worth reporting — Stage 1's design bet is that it shouldn't
happen, and customer/product's runners exist for a _different_ reason
(reusing pre-existing complex write-side logic), not because `UPSERT` is
secretly insufficient.

## Files

- `app/prisma/schema.prisma` — `ImportDefinition`, `ImportFieldMapping`,
  `ImportValueMapping`, `ImportMode`, `ImportSourceFormat`,
  `ImportTransform`
- `app/prisma/migrations/20260801120000_add_configurable_imports/` — the
  additive migration + the `ImportDefinition_reconcile_requires_runner`
  CHECK constraint
- `app/src/lib/imports/types.ts` — the client/server-safe contract
- `app/src/lib/imports/transforms.ts` — the six transforms
- `app/src/lib/imports/engine.ts` — `runImportEngine`, `computeNaturalKey`
- `app/src/lib/imports/validation.ts` — `validateImportDefinition`
- `app/src/lib/imports/runnerRegistry.ts` — the escape-hatch registry
- `app/src/lib/imports/runners/customerRunner.ts`,
  `.../productRunner.ts`, `.../adaptColumnMapping.ts` — the two registered
  runners proving the seam
- `app/src/lib/imports/data/ordoritePaymentMode.ts` — the Ordorite
  value-mapping proof data
- `app/prisma/seed/ordoritePaymentMode.ts` — persists that data as a real
  (inactive) `ImportDefinition`
- `app/__tests__/imports/` — `transforms.test.ts`, `engine.test.ts`,
  `validation.test.ts`, `runnerRegistry.test.ts`, `ordoritePaymentMode.test.ts`

## Cross-references

- `config-presets.md` — the authoring surface for these definitions: YAML/JSON
  presets and the admin GUI, one schema behind both, plus the audit trail
  every apply writes.

- `imports-overview.md` — the canonical map of the live, hand-coded
  Ordorite/POS import pipeline this stage does not yet touch
- `import-pipeline.md` — same-day rewrite cleanup, orphan line cleanup,
  and the other `RECONCILE`-shaped logic that motivates the escape hatch
- `docs/domains/consignment.md` — the consignment wash (another
  cross-entity reconciliation example the config surface can't express)

---

Last verified: 2026-08-01
