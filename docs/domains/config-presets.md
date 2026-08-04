# Config Presets

Per-deployment mappings as **data** — a file in git, or a form in the admin
UI — instead of object literals compiled into the product. This is the
mechanism that lets one codebase serve more than one deployment without a
fork, and it is the general form of the thing
`imports-configurable.md` built for importers specifically.

## Why this exists

The white box shipped with real deployment facts hardcoded in it. The clearest
example lived in `lib/storeColors.ts`:

```ts
const AXPER_TO_STORE_LOCATION: Record<string, string> = {
  "Main Showroom": "Main Showroom",
  "West Showroom": "West Showroom",
};
```

Those were honest placeholders, not leaked tenant data — but the shape is the
problem, not the values. Adding a store meant editing TypeScript and shipping a
release. Every deployment that added a store forked that file. And the same
pattern recurred: Ordorite payment codes, department translations, vendor
category maps. Each one a fact about *a* deployment, compiled into *the*
product.

The rule this establishes:

> **Policy is data; code is mechanism.** A preset selects behaviour from a
> fixed catalog. It can never supply behaviour.

That boundary is what makes it safe to accept a preset from a pull request, a
file upload, or an admin form. A preset can say `runnerKey: product`, naming a
runner that already exists in the compile-time registry
(`lib/imports/runnerRegistry.ts` — today `customer` and `product`). It cannot
define what that runner does, and an unregistered key is a hard failure at
apply time. There is no expression language, no eval, no
plugin loading — the transform vocabulary is six fixed keys
(`TRIM`/`UPPERCASE`/`LOWERCASE`/`NUMBER`/`DATE`/`CURRENCY`) and that is
deliberate. A DSL here would be a remote code execution surface wearing a
config file's clothes.

## Two doors, one store

| | GitOps | GUI |
|---|---|---|
| Surface | `config/**/*.{yaml,yml,json}` | Admin → Settings → Configuration |
| Applied by | `node app/scripts/apply-preset.mjs` | the form's save action |
| Reviewable | yes — it is a diff in a PR | no |
| Needs a deploy | no (apply runs against a live DB) | no |
| Good for | reproducible environments, multi-tenant fleets | an operator adding one store |

Both validate against the **same zod schema** (`lib/config/presetSchema.ts`)
and write the **same rows**. The GUI exports back to YAML or JSON, so a change
made in the browser can be committed; export is deterministic (fixed key order,
sorted maps) so a re-export is never a spurious diff.

Neither door is the "real" one. A shop that runs GitOps for everything can
ignore the GUI; a shop with no engineers can ignore the files.

## The three config sets

| Directory | Committed | Purpose |
|---|---|---|
| `config/presets/` | **yes** | White-box defaults, tuned to the demo seed so a fresh clone works out of the box. |
| `config/local/` | **no** (gitignored) | One deployment's real mappings — `saybrook.yaml`, `akritos.json`. |
| `$HOLT_CONFIG_DIR` | n/a | Override for config kept in a private repo or a mounted volume. |

`config/local/` is gitignored because a tenant's store names and vendor payment
codes are deployment data, not product code — the same reasoning as
`docs/TENANCY.md`. A commented template lives at `config/example.yaml` — at
config root, **not** inside `config/local/`, because the loader scans only
`config/presets/` and `config/local/`, and an example sitting in a scanned
directory is live configuration. That is not hypothetical: it showed up in the
override report and would have applied a fictional "acme-customer-export"
importer to a fresh clone.

On a `(kind, name)` collision **local wins**, and every override is reported by
name when you apply. A deployment overrides one shipped default without
touching the rest; a silent override is how you end up running configuration
nobody remembers writing.

## YAML or JSON

Interchangeable, by design and by test. YAML 1.2 is a superset of JSON, both go
through one schema, and `__tests__/config/presets.test.ts` parses the same
document in both spellings and asserts deep equality — so the claim stays true
as the schema grows.

Pick on team preference. YAML gets you comments, which in a mapping file
(*"why does Marketing map to OTHER?"*) usually earn their keep.

Parser safety is not left to defaults:

- **`maxAliasCount: 100`** — bounds anchor/alias expansion. Without it a
  ~200-byte document expands to gigabytes during parse and takes the process
  down (the billion-laughs attack). Set explicitly so a future library default
  change cannot quietly remove the protection.
- **`customTags: []`** registers no tag handlers of our own. It is not, by
  itself, a refusal: the core schema still resolves `!!binary` to a Buffer and
  `!!timestamp` to a Date. `assertPlainData()` is what enforces data-only, by
  rejecting any parsed value that is not a string, finite number, boolean,
  null, array or plain object.
- **`version: "1.2"`** — pinned so a store code like `NO` stays the string
  `"NO"` instead of becoming boolean `false` under YAML 1.1 rules. Short
  uppercase tokens are exactly what this bites, and store and payment codes are
  full of them.
- **512 KB ceiling**, enforced at every entry point (disk read, HTTP upload) —
  a real mapping file is tens of KB; a megabyte is a mistake or a probe.
- **Path traversal** is blocked at one choke point (`safeJoin`), belt and
  braces: the name is pattern-checked *and* the resolved path is verified to
  still sit under the config root. Only the CLI turns user input into a path
  today — the GUI reads uploaded text and never names a file — but the check
  lives in the loader rather than in the CLI so a future caller inherits it.
- **Credential-shaped keys are refused outright.** Presets are committed in
  plaintext and rendered in the GUI. Secrets belong in `IntegrationCredential`,
  encrypted at rest (`docs/SECRETS.md`). The loader enforces this rather than
  trusting the convention.

## Applying

```bash
node app/scripts/apply-preset.mjs --dry-run     # show the diff, write nothing
node app/scripts/apply-preset.mjs               # apply everything
node app/scripts/apply-preset.mjs --file config/local/saybrook.yaml
```

Two properties matter more than the rest:

**Idempotent.** Applying twice reports `UNCHANGED` the second time and writes no
configuration rows — the diff is computed before anything is written. It does
still append one `ConfigChangeLog` row per preset, deliberately: "we applied
this and it was already correct" is a fact an audit wants, and a re-apply that
left no trace would be indistinguishable from never having run. For
`traffic-store-mapping` this includes a stable answer to "who owns this
store" across every preset of that kind, not just the one being applied —
see "Ownership" under that kind, below. Without that, two presets naming the
same store would each report `APPLIED` forever, trading it back and forth
depending on which file happened to apply last — the opposite of idempotent.

**Declarative.** A preset is desired state, not an append. Delete a line from
the YAML, re-apply, and the corresponding row goes away. This is what makes
GitOps actually work — without it, the file drifts from the database the first
time someone removes a mapping and nothing happens.

Each definition's reconcile runs in a single transaction, so a partial apply
cannot leave a definition with half its mappings updated.

The script prints the target database **name** before writing (never the
password), and refuses to write to anything other than `fbc_dev_db` without an
explicit `--yes`. Applying tenant config to the wrong database is the obvious
foot-gun, and `saybrook` / `holt_saybrook` / `akritos` hold restored data
(CLAUDE.md rule 59).

## In Docker

`config/` is **mounted, not baked into the image**. Two reasons, and the first
one is not optional:

1. The build context is `./app`, so repo-root `config/` is not reachable by a
   `COPY` at all. Without a mount, `resolveConfigRoot()` resolves to
   `/app/../config` = `/config`, which does not exist, and every preset
   silently resolves to nothing. The loader treats a missing directory as
   normal (a fresh clone has no `config/local/`), so this fails *quietly* —
   which is exactly why it is called out here.
2. Changing a mapping should not require an image rebuild. That is the point
   of config-as-data.

`docker-compose.yml` mounts it at `/etc/holt/config` and sets
`HOLT_CONFIG_DIR` to match — read-only in production (the app reads presets
and writes rows; it never writes files, and the GUI's export is a download),
writable in the dev profile so presets can be edited in place.

**The CLI does not run inside the production image.** The runtime stage copies
only `public/`, `package.json`, `node_modules/`, `.next/`, `prisma/` and
`next.config.js` — no `scripts/`, no `src/`, and `apply-preset` needs both
plus `ts-node`. In production the two doors are: the **admin GUI**, or running
the CLI **from a checkout / CI job** pointed at the production `DATABASE_URL`.
That is a deliberate split, not an oversight — a container that can rewrite
its own interpretation rules is a bigger blast radius than one that cannot.

## Audit trail

Applying a preset changes how holt *interprets* data — which payment string
means `CARD`, and therefore which GL account the money lands in. "Who changed
this mapping, when, and from which file" has to be answerable months later,
during a reconciliation dispute.

Two layers:

- **`ConfigChangeLog`** (durable) — one row per preset applied, from either
  door: `presetKind`, `presetName`, `action` (`APPLIED` / `UNCHANGED` /
  `FAILED`), `source` (`cli:config/local/saybrook.yaml` or `gui`), `summary`
  (counts plus what moved), `actor`, `created`. Append-only by convention.
  Deliberately records `UNCHANGED` and `FAILED` too — "we tried and it was
  already right" and "we tried and it broke" are both things you want in the
  history.
- **The log stream** — `auditLog("CONFIG_PRESET_APPLY", ...)` from
  `lib/audit.ts`, plus operational detail through `lib/logger.ts`.

The log stream alone is not enough: it rotates, and it cannot be joined against
a journal entry.

`summary` holds counts plus the mappings that actually changed — including
their source and target values, because "Card Connect stopped mapping to CARD"
is the whole point of the record during a reconciliation dispute. It does not
hold the unchanged remainder of the preset; the file stays the source of truth
for content.

## Kinds

### `import-definition`

A declarative CSV/XLSX importer — field mappings plus value mappings. Full
treatment in `imports-configurable.md`, including the delta-vs-full-state
distinction that decides whether an importer can be pure config at all.

Two rules are enforced at apply time rather than in the schema, because they
depend on server-side catalogs:

- An unknown `targetEntity` is **saved but forced inactive**, with the reason
  recorded. This is not sloppiness — it is how a preset documents an intended
  mapping before the entity exists. `ordorite-payment-modes` ships exactly this
  way: `targetEntity: payment` has no entry in `IMPORT_ENTITIES` yet.
- An unknown `runnerKey` is a **hard failure**. A runnerKey names executable
  behaviour; accepting a name that resolves to nothing would let a `RECONCILE`
  definition look configured while doing nothing at all. Different risk,
  different answer.

### `traffic-store-mapping`

Maps a traffic counter's own door labels onto `StoreLocation` records, stored
as `StoreLocation.trafficSourceNames String[]`. This replaced the two hardcoded
literals in `lib/storeColors.ts`.

The counter, the POS, and holt rarely agree on what a store is called, and one
store can own several counter labels — two co-located buildings counted
separately still roll up to one store. Saybrook's real data is exactly this
shape: `NB` and `SB` are two doors of one showroom, and reading either alone
computes conversion against half the store's traffic.

An unmapped label is **never dropped**. It flows through under its raw name and
is logged once per unique name, so a newly-installed door shows up as something
to fix rather than as missing visitors.

A preset maps onto stores that already exist; it never creates one. Creating a
store has downstream effects on registers, stock locations and receiving
defaults that a mapping file has no business triggering.

`getStoreColor()` stayed in `lib/storeColors.ts` untouched — colours are
assigned by index and already scale to any number of stores without code
changes. Only the name mappings were the problem.

#### Ownership

**A store may be claimed by exactly one `traffic-store-mapping` preset at a
time.** `StoreLocation` itself has no column recording which preset last
claimed it — the only record is `ConfigChangeLog.summary.ownedStores`, one
entry per successful (`APPLIED` or `UNCHANGED`) apply, keyed by that preset's
`name`. Without a rule enforcing single ownership, two differently-named
presets that both list the same store would reclaim it from each other on
every apply: both permanently report `APPLIED`, and the "winner" is whichever
one ran last — for the CLI's file-order loop, whichever file happens to sort
last. That is not idempotent by any definition worth having.

So: `applyPreset()` looks up each store's current owner across **every**
`traffic-store-mapping` preset's history (`currentTrafficStoreOwners()` in
`applyPreset.ts`), not just the applying preset's own. A store already owned
by a *different* name is a **`FAILED`** apply for the preset trying to claim
it, naming the current owner. That failure is stable on re-apply — it does
not flip back and forth — which is what makes it idempotent: the same input
produces the same result every time, even though that result is "no."

To move a store from one preset to another on purpose, release it under the
old name first (re-apply that preset without the store, or with an empty
`stores` list) and only then claim it under the new name. There is
deliberately no "steal" or "force-claim" operation — a store changing hands
is exactly the kind of thing that should require a visible, separate step,
not fall out of applying a file that happens to mention it.

**Renaming** a preset is a special case of this: the renamed file has no
`ConfigChangeLog` history of its own, but if it still claims a store the
*old* name owns, the ownership check above catches it — the store's current
owner is the old name, which does not match the new one, so the apply fails
loudly and names the old preset. That is deliberate: silently reporting "no
changes" while the old name's stores sit unreleased is the orphaned-ownership
failure mode this whole mechanism exists to prevent. Release the stores under
the old name (or keep at least one store in common across the rename so this
check has something to catch) before reusing the new name. A rename that
drops **every** store the preset owned, in the same edit, with nothing left
in common with the old name, is a residual gap this check cannot see —
there is nothing left for it to compare against. Prefer a two-step rename in
that case: release everything under the old name first, confirm the stores
read back empty, then introduce the new name.

The admin GUI is just another `traffic-store-mapping` preset as far as this
rule is concerned — it applies under the fixed name
`TRAFFIC_STORE_MAPPING_PRESET_NAME` ("traffic-stores"). `loadDbConfigState()`
(the GET-route/export read path) renders the live database back out grouped
by each store's *real* current owner rather than collapsing every store
under that one fixed name — otherwise an export from a deployment whose CLI
preset uses a different name would be unusable: re-importing it would try to
reclaim stores that preset never actually owns and fail the whole
traffic-store-mapping apply as a conflict, even though nothing substantive
had changed. A store with no ownership history at all (`trafficSourceNames`
set some other way — a direct write, an old fixture) falls back to the GUI's
own default name.

## Adding a kind

1. Add a schema to `lib/config/presetSchema.ts` and put it in the
   `presetSchema` discriminated union.
2. Add its branch to `applyPreset()`, including the diff that makes re-apply a
   no-op.
3. Add the export ordering to `orderBundle()` in `presetSerialize.ts` — the
   determinism guarantee is per-kind.
4. Add a GUI panel.
5. Extend `__tests__/config/presets.test.ts`, including the YAML/JSON parity
   case.

Do **not** add an expression language, a conditional, or a computed value. When
a mapping needs logic it needs a runner, and a runner is code that lives in the
registry and goes through review.

## Related

- `imports-configurable.md` — the importer engine presets feed
- `imports-overview.md`, `import-pipeline.md` — the hand-coded pipeline still
  live for production imports
- `modules.md` — the same policy-as-data pattern for feature modules
- `../TENANCY.md` — why tenant data stays out of the white box
- `../SECRETS.md` — where credentials go instead
