# Operations Guide — Detailed Runbook

This is the detailed operations runbook: scheduled tasks, monitoring, and
troubleshooting. For the quick-start deploy/backup/restore reference, see the
top-level [OPERATIONS.md](../OPERATIONS.md).

Throughout, replace the placeholders with your deployment's values:

- `<deploy-path>` — where the repo lives on the host
- `<db-container>` / `<app-container>` — the Compose container names
- `<db-user>` / `<db-name>` — Postgres role and database

## Deployment

Production runs on any Docker host via Docker Compose (a NAS with a container
manager works); nothing below is host-specific.

### Standard Deploy

```bash
# SSH to the host, then:
cd <deploy-path>
./scripts/deploy.sh
```

The deploy script:

1. Pulls latest from `origin/main`
2. Embeds the git commit hash for health endpoint verification
3. Builds the app image (set `DOCKER_BUILDKIT=0` on older hosts where BuildKit fails)
4. Restarts app and nginx containers
5. Verifies via health endpoint

### Manual Deploy

```bash
git pull origin main
GIT_COMMIT=$(git rev-parse --short HEAD)
echo "GIT_COMMIT=$GIT_COMMIT" >> .env
DOCKER_BUILDKIT=0 docker compose build app
docker compose up -d app nginx
curl http://localhost:3000/api/health
```

## Monitoring

### Health Endpoint

```
GET /api/health
```

Returns:

```json
{
  "status": "ok",
  "database": "ok",
  "version": "2.0.1",
  "gitCommit": "abc1234",
  "nodeEnv": "production",
  "timestamp": "2026-03-24T12:00:00.000Z"
}
```

- `status: "ok"` -- app and database are healthy
- `status: "degraded"` -- app is running but database is unreachable (HTTP 503)
- Unauthenticated -- safe for external monitoring tools

### Application Logs

```bash
# All app logs
docker compose logs app --tail 100

# Follow in real-time
docker compose logs -f app

# Filter for errors
docker compose logs app 2>&1 | grep '"level":"error"'

# Filter for audit events
docker compose logs app 2>&1 | grep '"audit":true'
```

In production, the logger outputs newline-delimited JSON for machine parsing.

### Database Logs

```bash
docker compose logs db --tail 50
```

## Scheduled Tasks

A store controls these itself, at **Admin → Automations**: whether each runs, when, and how it
last went (`docs/domains/automations.md`). A host's scheduler does one thing: every 5 minutes,
`scripts/auto-automations.sh` wakes Holt with a Bearer token (`AUTO_IMPORT_API_KEY` in
`app/.env.local`), and Holt decides what's due. `scripts/install-cron.sh` installs that line and the
backups. The screen warns if nothing has woken Holt in 15 minutes.

Each section below says what a job does, and any time given is what it starts with.

Some tasks below describe optional integrations (door-counter traffic, the
POS/ERP import, Mailchimp). They run only when the corresponding integration is
configured at **Admin → Settings → Integrations**.

### Traffic Sync

Starts off, at 2 AM store time, and needs the door counter set up. Snapshots yesterday's per-store
door-counter traffic into `TrafficSnapshot`, and auto-backfills any day in the
last 30 with zero existing rows (gap-healing). Today's traffic is still pulled
live by the dashboard widgets (the counter closes the day at midnight, so the
cron runs against the previous day's final data). Reference integration: Axper.

**One-time historical backfill (when seeding new reports):**

The admin page at `/admin/automations/axper-traffic` exposes a "Set 2-year backfill" button (730 days). Click it then "Run Now". Each in-window day is one API call; full 730-day backfill takes ~12-13 minutes and is idempotent — re-running picks up only days the DB doesn't already have. Cap on the input is 800 days.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- `/admin/automations/axper-traffic` — last 20 runs with row counts + errors per run
- `TrafficSyncLog` table for the audit trail

**If it stops working:**

1. Check Admin → Automations: is it on, is Holt being woken, and how did it last go?
2. Check `logs/auto-automations.log` on the host for curl errors or "401 Unauthorized" (`AUTO_IMPORT_API_KEY` wrong or missing)
3. Confirm the door-counter API key is set under Integrations (separate from the Bearer token)
4. Hit the dashboard's live-traffic widget — if it shows today's data, the counter is reachable and the issue is on our side

### Daily Import (POS/ERP)

Starts off, at 6 AM, and needs the import set up. Fetches POS/ERP CSV reports from the
configured mailbox and processes them through the import pipeline. Reference
preset: the POS (CSV reports delivered to a labeled Gmail inbox).

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- Check `/admin/import/automated` in the app for last run results
- Import health cards show hours since last successful import per type

**If imports stop working:**

1. Check Admin → Automations: is it on, is Holt being woken, and how did it last go?
2. Check `logs/auto-automations.log` on the host for curl errors or "401 Unauthorized" (`AUTO_IMPORT_API_KEY` wrong or missing)
3. Check the source mailbox -- are reports arriving in the "Automations" label?
4. Check `AUTO_IMPORT_API_KEY` in `app/.env.local` matches what the script uses
5. Check the app container is running: `docker compose ps`

### Mailchimp Sync

Starts off, at 5 AM, and needs Mailchimp set up. Orchestrates campaigns → metrics (30-day window) → activity (14-day window) → auto lead ingestion. All four phases run in one pass; individual phases can be triggered via `?phase=campaigns|metrics|activity|ingest-leads`.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- `/admin/automations/mailchimp-sync` shows last run + per-phase history
- `MailchimpSyncLog` table rows with `kind = 'mailchimp-sync'` (or `mailchimp-sync:<phase>`)
- Health endpoint `/api/automations/mailchimp-health` flags stale after 36 hours

### Lead Housekeeping

Starts off, at 5 AM. Auto-archives NEW/ASSIGNED leads that have been silent for 30 days (`ARCHIVE_AFTER_DAYS` in `lib/leadHousekeeping.ts`). Pinned leads and leads whose customer has an active QUOTE are exempt.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- `MailchimpSyncLog` rows with `kind = 'lead-housekeeping'`
- `/leads` board — aged leads get `status = LOST` and `archivedBy = "auto"`

### Customer AR Drift Check

Starts on, at 4 AM. Walks every customer that had payment or ledger activity in the last 26 hours, recomputes their source-of-truth balance (line items + payments — cancelled lines excluded), and compares to `Customer.openArBalance`. Drift > $0.005 (`LEDGER_TOLERANCE`) gets flagged in the response.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- App logs (`logger.warn` when drift detected, `logger.info` otherwise)
- Admin page at `/admin/automations/customer-ar-drift-check` — two modes (ADMIN/MANAGER only):
  - **By recent activity** (default): replays the cron-style check on-demand. Default 26h lookback; widen to 7d / 30d to investigate older drift.
  - **Specific customer IDs**: paste a list of customer IDs (one per line or comma-separated). Validates exactly those customers regardless of recent activity. Use for a hand-picked pre-cutover validation pass against the source system's reported balances.

**On drift detected:** investigate the listed customer ids. The most common causes are (a) a payment was written by code that bypassed `appendEntry`, (b) a payment got VOIDED after its ledger entry was written, (c) someone manually UPDATEd a SalesOrder/Payment via SQL. The drift report's `diff` is signed — NEGATIVE means stored is BELOW source (we believe they owe LESS than the source rows say — the under-billing case worth investigating first).

### Customer Level Recalculation

Starts on, Sundays at 4 AM. Refreshes `Customer.customerLevel` / `lifetimeSpend` / `lifetimeOrderCount` / `customerGroup` / `peakCustomerLevel` using department-group-aware windows (see `lib/customerLeveling.ts`). Weekly cadence aligns with the wealth-enrichment refresh so leveling and wealth data move together.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- `MailchimpSyncLog` rows with `kind = 'customer-level-recalc'`
- `/admin/tools/recalculate-levels` still works for ad-hoc triggers (the manual button calls the same pure helper).

### Mailchimp New Customer Sync

Starts off, at 6 AM, and needs Mailchimp set up. Pushes new customers (with email, created on/after the import-handoff cutoff in `lib/mailchimpAudienceSync.ts`, not yet synced) into your Mailchimp audience as PENDING (Mailchimp sends them a double opt-in confirmation). Idempotent: existing subscribed members keep their status; only genuinely new contacts get the confirmation. Per-run cap of 200 contacts to stay under Mailchimp's rate limits.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
- `/admin/automations/mailchimp-sync` (the "Push new customers" panel) shows last run + per-customer push results
- `Customer.mailchimpSyncedAt` populated on the rows just pushed
- Spot-check a sample customer in Mailchimp's audience UI — should have `pending` status

### Expire Quote Holds

Starts on, hourly. A quote can hold a floor-stock line for its
customer through a chosen day (GAP-16; `docs/domains/sales-orders.md`, "Quote
holds"). After that day the piece should be back on sale, but a quote nobody
touches again has no edit to release it, so this sweep does: it resyncs every
quote still committing stock, which lets go of any line whose hold has ended.
It also releases what quotes written before holds existed still commit (every
quote used to commit every line). Idempotent: a second run releases nothing.

**Verify it ran:**

- Admin → Automations: when it last ran and how it went
  `{ checked, released, units }`
- Reports › On hold no longer lists a hold the day after its last day

### Email Queue

Starts every 5 minutes. It first queues
the automatic customer messages that are due (GAP-13, Settings › Customer
messages; `docs/domains/email.md`), the daily low-stock list (GAP-14) and the morning follow-up
emails (GAP-36), then
sends what is waiting in the email and text queues and retries what failed
(`docs/domains/sms.md`). Without it no email goes at all: invoices, booking and
ticket confirmations, password resets, every customer message and the low-stock
list. A text staff send by hand still goes at once.

**Verify it ran:**

- Admin → Automations: when it last ran and how many went
- Admin › Email shows nothing PENDING for longer than a few minutes once SMTP
  is set up

### Database Backup

Stays in the host's cron, using `scripts/backup-db.sh`: it runs outside the app, and shouldn't depend on the app being up.

### Scheduled Tasks at a Glance

What each starts as. A store changes these at Admin → Automations.

| Automation | Starts as | Route for a manual run |
|---|---|---|
| Send waiting emails and texts | On, every 5 minutes | `/api/automations/email-queue` |
| Release expired quote holds | On, hourly | `/api/automations/expire-quote-holds` |
| Clear abandoned card checkouts | On, hourly | `/api/automations/expire-stale-pending-payments` |
| Daily reconciliation | On, 10 PM | `/api/automations/daily-reconciliation` |
| Customer balance check | On, 4 AM | `/api/automations/customer-ar-drift-check` |
| Customer levels and lifetime spend | On, Sundays 4 AM | `/api/automations/customer-level-recalc` |
| Archive stale leads | Off, 5 AM | `/api/automations/lead-housekeeping` |
| Daily POS import | Off, 6 AM | `/api/automations/source-import` |
| Door counter traffic | Off, 2 AM | `/api/automations/axper-traffic-sync` |
| Mailchimp campaign results | Off, 5 AM | `/api/automations/mailchimp-sync` |
| Add new customers to Mailchimp | Off, 6 AM | `/api/automations/mailchimp-customer-sync` |
| Database and upload backups | In the host's cron, 1:15 and 1:45 AM | n/a |

Per-run audit lives in the appropriate `*SyncLog` table — `TrafficSyncLog`, `MailchimpSyncLog`, `AutoImportLog`, `CustomerArDriftLog`, `DailyReconciliationLog`. The admin pages under `/admin/automations/*` surface the latest run + Run Now button for each.

### Adding a new scheduled task

Add it to the catalog, not to cron: `docs/domains/automations.md`, "Adding one". A store has to be
able to switch it on and off and choose when it runs from its first PR.

## Code Quality

Lint carries the code-quality rules (`app/eslint.config.mjs`, including a
subset of SonarSource's through `eslint-plugin-sonarjs`), and CodeQL in CI
carries the security analysis. A local SonarQube server
(`docker-compose.sonar.yml`) did both until 2026-10-16, when it was removed
at the owner's direction: it was not being run, and CodeQL covers the
analysis. Its `sonar-data` and
`sonar-db-data` Docker volumes can be deleted on any machine that still has
them.

## One-Time Scripts

One-off backfill/migration scripts live in `scripts/`. They are designed to be
idempotent (re-runnable) where possible — typically upserting by a business key
— so a partial run can be safely retried.

```bash
cd app && node scripts/<script-name>.js
```

## Prisma CLI Commands

Prisma 7 uses `prisma.config.ts` (in `app/`) for CLI configuration. The `datasource.url` is defined there, not in `schema.prisma`. Key commands:

```bash
cd app
npx prisma generate          # Regenerate client (required after schema changes)
npx prisma migrate dev       # Create migration (development)
npx prisma db push           # Push schema changes without migration
```

The runtime PrismaClient uses the `PrismaPg` driver adapter configured in `lib/prisma.ts`, not the CLI config.

The production image has no npm or npx: its runner stage deletes them. Inside the app container, call the CLI by path, for example `docker compose exec app node_modules/.bin/prisma migrate status`.

## Common Troubleshooting

### Import Times Out

The Prisma transaction timeout is 300 seconds (5 minutes). The Nginx proxy timeout matches. If an import fails with a timeout:

1. Check the payload size -- large price books (2000+ products) may need to be split
2. Check database load -- `docker exec <db-container> psql -U <db-user> -d <db-name> -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"`
3. The 20MB body parser limit may also be hit for very large CSV/XLSX files

### PDF Image Extraction Fails

The `pdfimages` CLI from `poppler-utils` must be installed in the container. It is installed in both the dev and prod Dockerfiles. If extraction fails:

1. Verify poppler is installed: `docker exec <app-container> which pdfimages`
2. Check the PDF is not password-protected or corrupted
3. Check disk space in the uploads volume

### App Won't Start

1. Check logs: `docker compose logs app --tail 50`
2. Check database is healthy: `docker compose exec db pg_isready -U <db-user>`
3. Check `.env` and `app/.env.local` exist with correct values
4. Check Prisma client is generated: rebuild with `docker compose up -d --build app`

### Database Connection Pool Exhaustion

If requests are slow or timing out without obvious database issues, the connection pool may be exhausted. The pool size is set via `?connection_limit=20&pool_timeout=10` on `DATABASE_URL` in `.env`. The default (based on CPU count) can be as low as 5 connections on modest hardware. Increase `connection_limit` if running heavy concurrent imports alongside normal browsing.

### Database Connection Refused

The database runs on host port 5433 (not 5432) to avoid conflicts with any Postgres running natively on the host. Inside Docker, it is port 5432.

```bash
# From host
psql -h localhost -p 5433 -U <db-user> -d <db-name>

# From within Docker network
docker compose exec app sh -c "psql \$DATABASE_URL"
```

### Staff Locked Out (No Admin)

The bootstrap safeguard allows any authenticated user to access admin pages when no privileged user (ADMIN or SUPER_ADMIN) with a linked user account exists. If all privileged users are deactivated:

1. Any authenticated Google user can access `/admin/staff`
2. Promote a staff member to ADMIN
3. The safeguard logs a warning when triggered -- check audit logs

Note: The API prevents removing the last ADMIN. You cannot demote the last active ADMIN via the staff page.

## Port Reference

| Service | Host Port | Container Port | Notes |
|---------|-----------|----------------|-------|
| PostgreSQL | 5433 | 5432 | Avoids conflict with a host-native Postgres |
| Next.js | 3000 | 3000 | Direct app access |
| Nginx | 8080 | 80 | Production reverse proxy |

## Backup Schedule

See [DISASTER-RECOVERY.md](./DISASTER-RECOVERY.md) for backup configuration and restore procedures.
