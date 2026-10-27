# Deployments (white-label model)

How one product codebase serves many branded instances without forking the
code.

## The model

- **Product = code.** This repo (Holt) is the white-box. It ships generic
  example content (`app/scripts/seed-cms.mjs`) and a generic default theme
  (`DEFAULT_THEME` in `lib/appSettings.ts`). No tenant's brand or content is in
  the product.
- **A deployment = data.** Everything that makes an instance "Acme" instead of
  "Holt" lives in its **database + env**, never in product code:
  - `AppSettings` row — `appName`, `logoUrl`/`loginLogoUrl`/`faviconUrl`,
    `tagline`, `theme` (the brand palette), `currency`/`locale`/`timezone`,
    `features` (which modules are on).
  - CMS `Page`/`Post`/`Menu` rows — the public site.
  - `IntegrationCredential` rows — encrypted per-tenant API keys.
  - Env secrets — `DATABASE_URL`, `NEXTAUTH_SECRET`, `APP_ENCRYPTION_KEY`,
    `NEXTAUTH_URL` (the tenant's domain), optional `BOOKING_FEED_TOKEN`. Secrets
    are **injected per deploy, never in the data backup** — `APP_ENCRYPTION_KEY`
    is the one sacred key (it decrypts `IntegrationCredential`); preserve it in
    your secret store and re-inject on every deploy. Full model: `docs/SECRETS.md`.
- **Improvements are code, so they flow to every deployment for free.** There is
  no per-tenant fork to merge back. A deployment only adds its own data layer.

## Creating a tenant deployment (generic)

1. Run Holt's code (Docker image or `next start`) pointed at the tenant's DB.
2. `npm run create-admin <email> <password>` to bootstrap the first SUPER_ADMIN.
3. In **Admin → Settings**: set name, upload logo/favicon, set the theme palette,
   toggle modules (`features`). All of this is editable in-app afterward.
4. In **Admin → CMS**: build the public pages/posts/menus (or import them).
5. Set `NEXTAUTH_URL` to the tenant domain so sitemap/canonical/OG use it; point
   DNS at the deployment.

That's the entire white-label surface — no code changes.

## Editions (one core, configurations — never forks)

An **edition** is a named deployment recipe: a feature preset + seed data +
(optionally) an adapter package. Editions live as configuration and seeds; the
core repo stays a single product so improvements flow to every deployment.

- **Core** — this repo as shipped. Generic seeds, default theme, all optional
  modules off unless the catalog defaults them on.
- **Consultancy** (services edition) — booking, helpdesk, time tracking,
  CMS+blog and the `dmarcTools` addon, usually with the dark `theme.mode`. Its
  brand and site content come from the deployment's own kit (below), which
  never lives in this repo. **SEO guarantee:** when a deployment moves an
  existing site onto Holt, its kit is the canonical source of the pages and
  posts, at the live site's slugs so indexing carries over, and it must ride
  every environment move (it is data, not code).
- **Riverbend** (retail edition) — a retail feature preset (POS, inventory,
  warehousing, dispatch, purchasing, commissions) plus the **Ordorite adapter**:
  a self-contained import package (report runners, status derivation, rewrite /
  dedup quirk handling) that translates Ordorite's daily exports into Holt's
  models. Ordorite-specific logic lives only in the adapter — never in core
  reports or services. The adapter is the bridge that lets Holt run in parallel
  with the legacy system (daily reconciliation compares totals) until it becomes
  the system of record.

  **The adapter shipped 2026-06-10** at `app/src/lib/adapters/ordorite/`
  (gmailClient → reportRouter → 13 runners + every legacy-ERP quirk: phantom Gift-Card
  skip, orphan-cancel + rewrite-freeze + reactivation, same-day-rewrite
  three-gate sweep, pay-period attribution-lock preserve, consignment lifecycle
  sync, PO receipt recalc with 0-qty exclusion, product-link + salesperson-FK
  self-heal). Enable it per deployment:
  1. Flip the **`legacyPosImport`** feature flag ON (Settings → Modules, or the
     edition seed).
  2. Enter the Gmail **service-account JSON + delegate email** in
     Settings → Integrations → Gmail (or mount the file and set
     `GMAIL_SERVICE_ACCOUNT_PATH` + `GMAIL_DELEGATE_EMAIL`). The mailbox needs
     the `Automations` label and domain-wide delegation with `gmail.modify`.
  3. Schedule `scripts/auto-import.sh` daily ~06:10 (it sources
     `_cron-run.sh`, so failures alert via `OPS_ALERT_WEBHOOK`).
  4. Watch Admin → Legacy POS Auto-Import for per-file history + staleness.
  5. **Parallel-run trust gate:** while both systems ingest the same daily
     exports, run `scripts/parallel-run-compare.cjs` (read-only) with
     `HOLT_DATABASE_URL` + `LEGACY_DATABASE_URL` — it compares per-day revenue
     / tax / cash / order-count (and `--by-store`) using the canonical filters
     and exits non-zero on any drift. Zero drift over a sustained window is
     the cutover criterion.

Adding a future client = a new seed + feature preset, and an adapter only if
they migrate from a system with quirky exports.

## A deployment's own kit

A deployment's identity has two halves, and neither is product code:

- **Brand and content:** its logo, palette, menus, pages and posts. They live in
  the deployment's own seed script and captured content, kept outside the
  product repo (in `config/local/`, or in `.git/info/exclude` on the machine
  that holds them; `docs/TENANCY.md`). Apply it with `DATABASE_URL` loaded; it
  should be idempotent, like `scripts/seed-cms.mjs`.
- **Configuration:** import definitions and feature configuration as a preset in
  `config/local/<deployment>.json` or `.yaml` (the two formats are
  interchangeable), applied with the same idempotent `apply` CLI every
  deployment uses (`docs/domains/config-presets.md`).

To revert any instance to the generic white-box demo: `npm run seed:cms`.

## Moving a deployment onto Holt from another system

A deployment that runs on another system first brings its history in through an
importer for that system, then cuts over. Two exist today, each named for the
system it reads, never for a deployment:

- **Ordorite** (retail): the adapter in `app/src/lib/adapters/ordorite/`, above.
- **simplerms** (services): `app/scripts/migrate-simplerms.mjs`, a one-time
  migration. Dry-run it into a scratch database first:

  ```
  SOURCE_DATABASE_URL=postgres://.../simplerms_copy \
  DATABASE_URL=postgres://.../holt_staging \
  node scripts/migrate-simplerms.mjs --dry-run
  ```

  Review the per-entity counts and `scripts/migration-exceptions.json`
  (everything with no Holt home is listed, nothing silently disappears). Re-run
  without `--dry-run`; it is idempotent on natural keys (invoice number, ticket
  number, service slug, customer email) and backfills the AR subledger so the
  drift check ties out from day one.

The cutover, for any deployment:

1. **Verify SEO parity** of the staging instance (the deployment's kit plus the
   migrated data) against the live site:
   `node scripts/sitemap-diff.mjs https://<live-site> http://localhost:3000`.
   Exit 0 = every live URL exists and resolves on Holt. Anything missing blocks
   the cutover.
2. **Stand up the host.** Docker and the production compose (`app` + `db` +
   nginx profile). Env per `env.example`: `NEXTAUTH_URL` = the deployment's
   domain, a fresh `NEXTAUTH_SECRET`, `APP_ENCRYPTION_KEY` (sacred: keep it in
   the secret manager), `AUTH_LOCAL_ENABLED=1` until OAuth is configured. Apply
   migrations, `npm run create-admin`, apply the deployment's kit, then the data
   migration against a dump taken in the cutover window. Production secrets go
   in Settings → Integrations after first boot, never in files.
3. **Cut over.** Freeze writes on the old system, take the final dump, re-run the
   (idempotent) migration, point DNS at the new host, submit the sitemap in
   Search Console. Roll back = point DNS back; the old system was never
   modified.
4. **Decommission later, not same-day.** Keep the old system read-only for two
   weeks as the reference for any data question, then archive it.

## Keeping in sync

Holt is the single source of truth for code. A deployment carries only its data
layer. When Holt ships a feature or fix, every deployment gets it by pulling
Holt: nothing to re-implement, nothing to merge back.

## Local demo container rebuild (gotcha)

The local demo runs the prod image (`holt-app-1`) against the
host's dev DB (`holt-dev-db`, port 5435).

**Always bring it up with `scripts/dev-app-up.sh`** (`--build` to rebuild the
image first). Never hand-run `docker compose up app` — that path skips the two
things below and serves 500s. (See `.claude/skills/post-failure/SKILL.md`,
2026-06-05.)

```
scripts/dev-app-up.sh           # recreate the app container
scripts/dev-app-up.sh --build   # rebuild image, then recreate
```

The script encapsulates the two things that bite a naive `docker compose up`:

- **Uses `host.docker.internal:5435`, not `localhost:5435`.** Inside the
  container `localhost` is the container itself, so a `localhost`-based
  `DATABASE_URL` gives `ECONNREFUSED` on every query (and a blank-but-200
  build, since the `(site)` pages are `force-dynamic`). The script rewrites the
  host automatically.
- **Passes `--no-deps`.** The compose `app` service `depends_on: db`, and that
  `db` maps host `5433`, which collides with the other local project's Postgres.
  `--no-deps` recreates only `app` and leaves the already-running dev DB alone.

The script also prunes build cache (a full cache once filled Docker's disk and
crashed the dev DB) and polls `/` for a 200 before returning, so a failed
bring-up surfaces immediately instead of as a silent 500.
