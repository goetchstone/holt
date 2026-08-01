# Config presets

Per-deployment mappings expressed as files instead of code: which CSV column
feeds which field, which vendor's payment string means `CARD`, which
traffic-counter label is which store. Everything here is **data** — a preset
selects behaviour from a fixed catalog, it never supplies behaviour.

Two doors, one store:

- **GitOps** — edit a file here, review it in a pull request, apply it with
  `node app/scripts/apply-preset.mjs`.
- **GUI** — Admin → Settings → Configuration. Same schema, same validation,
  and it exports back to YAML or JSON so a change made in the browser can be
  committed.

YAML and JSON are interchangeable. Use whichever your team already lints;
neither can express something the other cannot. YAML gets you comments, which
in a mapping file are usually worth having.

## The three config sets

| Directory | Committed? | What it holds |
|---|---|---|
| `config/presets/` | **yes** | The white-box defaults. Tuned to the seed database, so a fresh clone works out of the box. |
| `config/local/` | **no** (gitignored) | One specific deployment's real mappings — `saybrook.yaml`, `akritos.yaml`. Tenant data, not product code. |
| `$HOLT_CONFIG_DIR` | n/a | Optional override for a deployment that keeps config in its own private repo or a mounted volume. |

On a `(kind, name)` collision, **local wins over shipped** — a deployment can
override one default without forking the rest. Every override is reported by
name when you apply, because a local file silently shadowing a shipped one is
exactly the surprise worth printing.

## Applying

```bash
node app/scripts/apply-preset.mjs --dry-run     # show the diff, write nothing
node app/scripts/apply-preset.mjs               # apply every preset
node app/scripts/apply-preset.mjs --file config/local/saybrook.yaml
```

Apply is **idempotent** and **declarative**: running it twice changes nothing
the second time, and deleting a line from a file then re-applying removes the
corresponding row. Desired state, not append.

Every apply writes a `ConfigChangeLog` row — who, when, from which file, what
moved. Applying a preset changes how holt *interprets* data (which payment
string means `CARD`, and therefore which GL account the money lands in), so
that history has to survive log rotation.

## Kinds

### `import-definition`

A declarative CSV/XLSX importer: field mappings plus value mappings. See
`docs/domains/imports-configurable.md`.

### `traffic-store-mapping`

Maps a traffic counter's own door labels onto `StoreLocation` records. The
counter, the POS, and holt rarely agree on a store's name, and one store can
own several counter labels (two co-located buildings counted separately).

A preset maps onto stores that already exist; it never creates one. Creating a
store has downstream effects on registers, stock locations and receiving
defaults that a mapping file has no business triggering.

## Never put secrets here

Presets are committed and reviewed in plaintext. API keys, tokens and
passwords belong in Integration Credentials (encrypted at rest — see
`docs/SECRETS.md`). The loader refuses any document containing a
credential-shaped key rather than trusting the convention.
