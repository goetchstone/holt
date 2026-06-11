# Deployments (white-label model)

How one product codebase serves many branded instances — and specifically how
**Akritos** runs on Holt without forking the code.

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
- **Akritos** (consultancy edition) — the maker's own deployment. Defined
  entirely by the gitignored `app/scripts/seed-akritos.mjs` +
  `app/scripts/akritos-content/`: consultancy feature preset (booking, helpdesk,
  time tracking, CMS+blog, `dmarcTools`), dark `theme.mode`, the akritos.com
  palette, and the full page/post content. **SEO guarantee:** `akritos-content/`
  is the canonical source of the akritos.com pages and posts — slugs are
  preserved from the live site so indexing carries over — and it must ride every
  environment move (it is data, not code; verified intact after the 2026-06-10
  environment rename).
- **Saybrook** (retail edition) — a retail feature preset (POS, inventory,
  warehousing, dispatch, purchasing, commissions) plus the **Ordorite adapter**:
  a self-contained import package (report runners, status derivation, rewrite /
  dedup quirk handling) that translates Ordorite's daily exports into Holt's
  models. Ordorite-specific logic lives only in the adapter — never in core
  reports or services. The adapter is the bridge that lets Holt run in parallel
  with the legacy system (daily reconciliation compares totals) until it becomes
  the system of record.

  **The adapter shipped 2026-06-10** at `app/src/lib/adapters/ordorite/`
  (gmailClient → reportRouter → 13 runners + every FC quirk: phantom Gift-Card
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

Adding a future client = a new seed + feature preset, and an adapter only if
they migrate from a system with quirky exports.

## The Akritos port

Akritos runs its own site + back-office on Holt. Its deployment layer is the
**akritos kit** (kept out of the white-box, gitignored under
`app/scripts/akritos-content/` + `app/scripts/seed-akritos.mjs` +
`public/akritos-logo.svg`):

- **Brand:** logo `/akritos-logo.svg`; theme = midnight `#1C1F2E`, conviction
  `#C8A96E`, parchment `#F5F4F0`, slate `#4A5068`, bone `#E8E4DC`.
- **Site:** all 27 akritos.com URLs (15 pages + 10 posts + `/blog` + `/book`)
  recreated as CMS content at the same slugs, captured faithfully from the
  source.
- **Apply it:** with `DATABASE_URL` loaded, `node scripts/seed-akritos.mjs`
  (idempotent — sets branding + theme + menus + pages + posts).

To revert any instance to the generic white-box demo: `npm run seed:cms`.

## Rebasing the `simplerms` repo onto Holt (owner-driven cutover)

Goal: `simplerms` becomes "Holt for Akritos" — Holt's code + the akritos
kit — while this repo stays the separate white-box product. This touches git and
live data, so the owner drives it.

1. **Point simplerms at Holt's code.** Add Holt as an upstream remote and
   replace simplerms's app with Holt's tree (or make simplerms a fresh repo
   seeded from Holt's code). Keep the akritos kit (above) in simplerms as its
   deployment layer. Future updates = pull from Holt upstream.
2. **Migrate data.** simplerms's current Prisma schema differs from Holt's.
   Export the akritos business data (clients, invoices, inventory, tickets,
   appointments) and import it through Holt's import paths / a one-time
   migration. The marketing site is already covered by the akritos kit.
3. **Stand it up.** Set env (`NEXTAUTH_URL=https://akritos.com`,
   `BOOKING_FEED_TOKEN`, secrets), run migrations, `create-admin`, then
   `seed-akritos.mjs`.
4. **Cut over.** Verify the 27 URLs + booking against the live site, then point
   akritos.com DNS at the new deployment and submit the sitemap. Same URLs +
   content ⇒ SEO authority carries over.

## Keeping in sync

Holt is the single source of truth for code. The Akritos deployment carries
only its data layer. When Holt ships a feature or fix, the Akritos deployment
gets it by pulling Holt — nothing to re-implement, nothing to merge back.

## Local demo container rebuild (gotcha)

The local Akritos demo runs the prod image (`holt-app-1`) against the
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

## VPS deploy kit (the Akritos cutover, step by step)

Everything below is local-preparable; only the final DNS step touches the
live site. Prereqs from the owner: SSH access to the akritos.com VPS, a
fresh dump of the production simplerms database, and the production
secrets (entered in Settings → Integrations after first boot, never in
files).

1. **Dry-run the data migration locally.** Restore the simplerms dump into
   a scratch DB, then:

   ```
   SOURCE_DATABASE_URL=postgres://.../simplerms_copy \
   DATABASE_URL=postgres://.../holt_staging \
   node scripts/migrate-simplerms.mjs --dry-run
   ```

   Review the per-entity counts + `scripts/migration-exceptions.json`
   (Client.company, notes, files — everything with no Holt home is listed,
   nothing silently disappears). Re-run without `--dry-run`; the script is
   idempotent (natural keys: invoice number, ticket number, service slug,
   customer email), and it backfills the AR subledger so the drift check
   ties out from day one. Then run the drift check to prove it.

2. **Verify SEO parity** against the staging instance with the akritos seed
   + migrated data loaded:

   ```
   node scripts/sitemap-diff.mjs https://akritos.com http://localhost:3000
   ```

   Exit 0 = every live URL exists and resolves on Holt. Anything missing
   blocks the cutover.

3. **Stand up the VPS.** Docker + the production compose (`docker-compose.yml`
   `app` + `db` + nginx profile). Env per `env.example`:
   `NEXTAUTH_URL=https://akritos.com`, fresh `NEXTAUTH_SECRET`,
   `APP_ENCRYPTION_KEY` (sacred — store it in the secret manager),
   `AUTH_LOCAL_ENABLED=1` until OAuth is configured. Apply migrations,
   `npm run create-admin`, run `seed-akritos.mjs`, then the data migration
   from step 1 against the real dump taken during the cutover window.

4. **Cut over.** Freeze writes on the old simplerms instance, take the
   final dump, re-run the (idempotent) migration, point DNS at the VPS,
   submit the sitemap in Search Console. Roll back = point DNS back; the
   old instance was never modified.

5. **Decommission later, not same-day.** Keep simplerms read-only for two
   weeks as the reference for any data question, then archive its volume.
