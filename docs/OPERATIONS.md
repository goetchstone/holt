# Operations Guide — Detailed Runbook

This is the detailed operations runbook: scheduled tasks, monitoring, and
troubleshooting. For the quick-start deploy/backup/restore reference, see the
top-level [OPERATIONS.md](../OPERATIONS.md).

Throughout, replace the placeholders with your deployment's values:

- `<deploy-path>` — where the repo lives on the host (the reference self-hosted
  deployment uses a path under the Docker host's data volume)
- `<db-container>` / `<app-container>` — the Compose container names
- `<db-user>` / `<db-name>` — Postgres role and database

## Deployment

Production runs on any Docker host via Docker Compose. The reference
single-store deployment runs on a Synology NAS via Container Manager; nothing
below depends on Synology specifically.

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

Cron-driven jobs are wired into the host's task scheduler (the reference
deployment uses Synology Task Scheduler; any cron will do). Each one calls an
authenticated `/api/automations/*` endpoint via a Bearer token
(`AUTO_IMPORT_API_KEY` in `app/.env.local`). The shell wrappers live in
`scripts/auto-*.sh` and log to `logs/`.

Some tasks below describe optional integrations (door-counter traffic, the
POS/ERP import, Mailchimp). They run only when the corresponding integration is
configured at **Admin → Settings → Integrations**.

### Traffic Sync

Runs daily at 02:00 ET via the host scheduler. Snapshots yesterday's per-store
door-counter traffic into `TrafficSnapshot`, and auto-backfills any day in the
last 30 with zero existing rows (gap-healing). Today's traffic is still pulled
live by the dashboard widgets (the counter closes the day at midnight, so the
cron runs against the previous day's final data). Reference integration: Axper.

**Scheduler config:**

- Task name: `Traffic Sync`
- User: `root`
- Schedule: Daily at 02:00 (America/New_York)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-axper-traffic.sh >> logs/auto-axper-traffic.log 2>&1
```

**One-time historical backfill (when seeding new reports):**

The admin page at `/admin/automations/axper-traffic` exposes a "Set 2-year backfill" button (730 days). Click it then "Run Now". Each in-window day is one API call; full 730-day backfill takes ~12-13 minutes and is idempotent — re-running picks up only days the DB doesn't already have. Cap on the input is 800 days.

**Verify it ran:**

- `logs/auto-axper-traffic.log` on the host
- `/admin/automations/axper-traffic` — last 20 runs with row counts + errors per run
- `TrafficSyncLog` table for the audit trail

**If it stops working:**

1. Check the scheduler shows the task as enabled and last result is 0
2. Check `logs/auto-axper-traffic.log` for curl errors or "401 Unauthorized" (means `AUTO_IMPORT_API_KEY` is wrong)
3. Confirm the door-counter API key is set under Integrations (separate from the Bearer token)
4. Hit the dashboard's live-traffic widget — if it shows today's data, the counter is reachable and the issue is on our side

### Daily Import (POS/ERP)

Runs daily at 06:10 via the host scheduler. Fetches POS/ERP CSV reports from the
configured mailbox and processes them through the import pipeline. Reference
preset: the POS (CSV reports delivered to a labeled Gmail inbox).

**Scheduler config:**

- Task name: `Daily Import`
- User: `root`
- Schedule: Daily at 06:10
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-import.sh >> logs/auto-import.log 2>&1
```

**Verify it ran:**

- Check `logs/auto-import.log` on the host
- Check `/admin/import/automated` in the app for last run results
- Import health cards show hours since last successful import per type

**If imports stop working:**

1. Check the scheduler shows the task as enabled and last result is 0
2. Check `logs/auto-import.log` for curl errors
3. Check the source mailbox -- are reports arriving in the "Automations" label?
4. Check `AUTO_IMPORT_API_KEY` in `app/.env.local` matches what the script uses
5. Check the app container is running: `docker compose ps`

### Mailchimp Sync

Runs daily via the host scheduler. Orchestrates campaigns → metrics (30-day window) → activity (14-day window) → auto lead ingestion. All four phases run in one pass; individual phases can be triggered via `?phase=campaigns|metrics|activity|ingest-leads`.

**Scheduler config:**

- Task name: `Mailchimp Sync`
- User: `root`
- Schedule: Daily (recommended 05:30 so it lands after lead-housekeeping at 05:00 and before import at 06:10)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-mailchimp-sync.sh >> logs/auto-mailchimp.log 2>&1
```

**Verify it ran:**

- `logs/auto-mailchimp.log` on the host
- `/admin/automations/mailchimp-sync` shows last run + per-phase history
- `MailchimpSyncLog` table rows with `kind = 'mailchimp-sync'` (or `mailchimp-sync:<phase>`)
- Health endpoint `/api/automations/mailchimp-health` flags stale after 36 hours

### Lead Housekeeping

Runs daily via the host scheduler. Auto-archives NEW/ASSIGNED leads that have been silent for 30 days (`ARCHIVE_AFTER_DAYS` in `lib/leadHousekeeping.ts`). Pinned leads and leads whose customer has an active QUOTE are exempt.

**Scheduler config:**

- Task name: `Lead Housekeeping`
- User: `root`
- Schedule: Daily at 05:00 (before import)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-lead-housekeeping.sh >> logs/auto-lead-housekeeping.log 2>&1
```

**Verify it ran:**

- `logs/auto-lead-housekeeping.log` on the host
- `MailchimpSyncLog` rows with `kind = 'lead-housekeeping'`
- `/leads` board — aged leads get `status = LOST` and `archivedBy = "auto"`

### Customer AR Drift Check

Runs daily via the host scheduler. Walks every customer that had payment or ledger activity in the last 26 hours, recomputes their source-of-truth balance (line items + payments — cancelled lines excluded), and compares to `Customer.openArBalance`. Drift > $0.005 (`LEDGER_TOLERANCE`) gets flagged in the response.

**Scheduler config:**

- Task name: `Customer AR Drift Check`
- User: `root`
- Schedule: Daily at 04:30 (before mailchimp-sync and lead-housekeeping at 05:00, after the system is quiet from overnight activity)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-customer-ar-drift-check.sh >> logs/auto-customer-ar-drift-check.log 2>&1
```

**Verify it ran:**

- `logs/auto-customer-ar-drift-check.log` on the host — JSON response with `checked`, `ok`, `drifted[]`, `totalAbsoluteDrift`
- App logs (`logger.warn` when drift detected, `logger.info` otherwise)
- Admin page at `/admin/automations/customer-ar-drift-check` — two modes (ADMIN/MANAGER only):
  - **By recent activity** (default): replays the cron-style check on-demand. Default 26h lookback; widen to 7d / 30d to investigate older drift.
  - **Specific customer IDs**: paste a list of customer IDs (one per line or comma-separated). Validates exactly those customers regardless of recent activity. Use for a hand-picked pre-cutover validation pass against the source system's reported balances.

**On drift detected:** investigate the listed customer ids. The most common causes are (a) a payment was written by code that bypassed `appendEntry`, (b) a payment got VOIDED after its ledger entry was written, (c) someone manually UPDATEd a SalesOrder/Payment via SQL. The drift report's `diff` is signed — NEGATIVE means stored is BELOW source (we believe they owe LESS than the source rows say — the under-billing case worth investigating first).

### Customer Level Recalculation

Runs weekly via the host scheduler. Refreshes `Customer.customerLevel` / `lifetimeSpend` / `lifetimeOrderCount` / `customerGroup` / `peakCustomerLevel` using department-group-aware windows (see `lib/customerLeveling.ts`). Weekly cadence aligns with the wealth-enrichment refresh so leveling and wealth data move together.

**Scheduler config:**

- Task name: `Customer Level Recalculation`
- User: `root`
- Schedule: Weekly Sunday at 04:30 (before lead-housekeeping at 05:00 so downstream jobs see fresh levels)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-customer-level-recalc.sh >> logs/auto-customer-level-recalc.log 2>&1
```

**Verify it ran:**

- `logs/auto-customer-level-recalc.log` on the host
- `MailchimpSyncLog` rows with `kind = 'customer-level-recalc'`
- `/admin/tools/recalculate-levels` still works for ad-hoc triggers (the manual button calls the same pure helper).

### Mailchimp New Customer Sync

Runs daily via the host scheduler. Pushes new customers (with email, created on/after the import-handoff cutoff in `lib/mailchimpAudienceSync.ts`, not yet synced) into your Mailchimp audience as PENDING (Mailchimp sends them a double opt-in confirmation). Idempotent: existing subscribed members keep their status; only genuinely new contacts get the confirmation. Per-run cap of 200 contacts to stay under Mailchimp's rate limits.

**Scheduler config:**

- Task name: `Mailchimp New Customer Sync`
- User: `root`
- Schedule: Daily at 06:30 (after the daily import at 06:10 so newly-imported customers from yesterday land before the push)
- Command:

```bash
cd <deploy-path> && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-mailchimp-customer-sync.sh >> logs/auto-mailchimp-customer-sync.log 2>&1
```

**Verify it ran:**

- `logs/auto-mailchimp-customer-sync.log` on the host
- `/admin/automations/mailchimp-sync` (the "Push new customers" panel) shows last run + per-customer push results
- `Customer.mailchimpSyncedAt` populated on the rows just pushed
- Spot-check a sample customer in Mailchimp's audience UI — should have `pending` status

### Database Backup

Runs daily via the host scheduler using `scripts/backup-db.sh`.

### Scheduled Tasks at a Glance

| Task | Schedule | Script | Endpoint |
|---|---|---|---|
| Traffic Sync | Daily 02:00 ET | `auto-axper-traffic.sh` | `/api/automations/axper-traffic-sync` |
| Customer Level Recalculation | Weekly Sunday 04:30 | `auto-customer-level-recalc.sh` | `/api/automations/customer-level-recalc` |
| Customer AR Drift Check | Daily 04:45 | `auto-customer-ar-drift-check.sh` | `/api/automations/customer-ar-drift-check` |
| Lead Housekeeping | Daily 05:00 | `auto-lead-housekeeping.sh` | `/api/automations/lead-housekeeping` |
| Mailchimp Sync | Daily 05:30 | `auto-mailchimp-sync.sh` | `/api/automations/mailchimp-sync` |
| Daily Import | Daily 06:10 | `auto-import.sh` | `/api/automations/gmail-import` |
| Mailchimp New Customer Sync | Daily 06:30 | `auto-mailchimp-customer-sync.sh` | `/api/automations/mailchimp-customer-sync` |
| Daily Reconciliation | Daily 22:30 | `auto-daily-reconciliation.sh` | `/api/automations/daily-reconciliation` |
| Database Backup | Daily | `backup-db.sh` | n/a |

Per-run audit lives in the appropriate `*SyncLog` table — `TrafficSyncLog`, `MailchimpSyncLog`, `AutoImportLog`, `CustomerArDriftLog`, `DailyReconciliationLog`. The admin pages under `/admin/automations/*` surface the latest run + Run Now button for each.

### Adding a new scheduled task — checklist

When you add a new cron-driven script, do all of the following in the same PR so the inventory above stays the source of truth:

1. **Create the script** in `scripts/auto-{name}.sh`. Mark executable (`chmod +x`).
2. **Wire the API endpoint** under `/api/automations/{name}` with bearer auth via `AUTO_IMPORT_API_KEY` (matches the pattern of every existing cron script).
3. **Add a section above** with: what it does, when it runs, the scheduler config block, and the "Verify it ran" steps.
4. **Add a row to the at-a-glance table** so a quick scan reveals everything the host needs to be running.
5. **Wire it into the host's task scheduler** as part of the deploy — the script existing in the repo doesn't make it run.

## Code Quality — SonarQube (local)

SonarQube Community Edition runs locally in Docker for code-quality
analysis (bugs, code smells, security hotspots, coverage, duplication).
Kept separate from the production stack — runs against whatever is on
your working copy.

### First-time setup

```bash
# From repo root — start Sonar + its own Postgres
docker compose -f docker-compose.sonar.yml up -d

# Wait ~2 min for bootstrap, then open
open http://localhost:9000
# Log in as admin / admin, change password when prompted.
# My Account → Security → Generate Token (keep the value).
```

### Run a scan

```bash
export SONAR_TOKEN=<token from UI>
cd app && npm run sonar:scan
```

The scanner reads `sonar-project.properties` at the repo root and uploads
findings to <http://localhost:9000>. Second + subsequent runs are
incremental against the same project key.

### With coverage

```bash
cd app && npm run test:coverage   # writes app/coverage/lcov.info
export SONAR_TOKEN=<token>
cd app && npm run sonar:scan      # reads lcov, shows uncovered lines
```

### Stop / clean up

```bash
docker compose -f docker-compose.sonar.yml down          # keeps data
docker compose -f docker-compose.sonar.yml down -v       # wipes history
```

Data persists in `sonar-data` and `sonar-db-data` volumes between
restarts, so the project history + triage notes survive reboots.

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
