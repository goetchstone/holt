# Operations Guide — Holt

This document covers everything needed to deploy, maintain, and recover a
self-hosted Holt deployment. Multi-tenant SaaS operations follow the same
fundamentals (Docker + PostgreSQL) but are centrally managed.

Throughout, replace the placeholders with your deployment's values:

- `<db-container>` — the database container name (e.g. `holt-db-1`)
- `<db-user>` / `<db-name>` — Postgres role and database
- `<your-domain>` — the public URL the app is served at
- `<deploy-path>` — where the repo lives on the host

## System Overview

- **Application**: Next.js 16 (TypeScript) running in Docker
- **Database**: PostgreSQL 17
- **Reverse Proxy**: Nginx
- **Host**: any Docker host. The reference single-store deployment runs on a
  Synology NAS via Container Manager; nothing depends on Synology specifically.

## Architecture (30-second version)

```
Internet -> Host -> Nginx (:8080) -> Next.js App (:3000) -> PostgreSQL (:5432)
```

- Nginx handles HTTPS termination and forwards to port 8080
- Nginx allows 50MB uploads and 300-second timeouts for large imports
- The app connects to PostgreSQL inside Docker on port 5432 (host port 5433)
- Database data is persisted in a Docker volume (`pgdata`)

## Credentials and Secrets

Holt splits secrets into two tiers:

**Bootstrap secrets (environment)** — needed before the database is reachable,
so they live in env files (never in git):

| File | Contents |
|------|----------|
| `.env` | `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| `app/.env.local` | `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `APP_ENCRYPTION_KEY`, Google OAuth client id/secret |

**Integration credentials (database)** — Stripe, Mailchimp, FileMaker, GitHub
App, door-counter, and any other provider keys are entered at
**Admin → Settings → Integrations**, stored encrypted at rest (AES-256-GCM,
keyed by `APP_ENCRYPTION_KEY`), and decrypted only server-side at the point of
use. They are never returned to the browser in plaintext.

If `APP_ENCRYPTION_KEY` is lost, stored integration credentials cannot be
decrypted and must be re-entered. Back it up alongside the database.

## Deploying a New Version

```bash
cd <deploy-path>
git pull origin main
./scripts/deploy.sh
```

The deploy script:

1. Reads the current git commit hash (embedded for health verification)
2. Builds the Docker image
3. Restarts the `app` and `nginx` containers
4. Waits, then hits `/api/health` to verify

> On some older Docker hosts (including Synology NAS) BuildKit fails; set
> `DOCKER_BUILDKIT=0` before building.

If the health check fails, check logs:

```bash
docker compose logs app --tail=50
```

To roll back:

```bash
git log --oneline -5          # find the last good commit
git checkout <commit-hash>
./scripts/deploy.sh
```

## Running Database Migrations

Migrations are SQL files in `app/prisma/migrations/`. They are applied manually,
not automatically.

```bash
# Always back up first
docker exec <db-container> pg_dump -U <db-user> <db-name> > backup-$(date +%Y%m%d).sql

# Apply a migration
docker exec -i <db-container> psql -U <db-user> -d <db-name> < app/prisma/migrations/<migration_name>/migration.sql
```

**Rules:**

- Never edit a migration file after it has been applied
- Always back up before applying
- Test migrations against a copy of the data first if possible
- Run migrations before deploying the code that depends on them

## Database Backup and Restore

### Manual Backup

```bash
docker exec <db-container> pg_dump -U <db-user> <db-name> > backups/holt-$(date +%Y%m%dT%H%M%S).sql
```

### Restore from Backup

```bash
# Stop the app first
docker compose stop app nginx

# Drop and recreate the database
docker exec -i <db-container> psql -U <db-user> -d postgres -c "DROP DATABASE <db-name>;"
docker exec -i <db-container> psql -U <db-user> -d postgres -c "CREATE DATABASE <db-name> OWNER <db-user>;"

# Restore
docker exec -i <db-container> psql -U <db-user> -d <db-name> < /path/to/backup.sql

# Restart
docker compose up -d app nginx
```

### Backup via API

There is also an endpoint at `GET /api/admin/database/backup` accessible to
MANAGER-role users. This returns a SQL dump as a downloadable file.

## Docker Services

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| `db` | postgres:17-alpine | 5433:5432 | Database (always running) |
| `app` | Built from `app/Dockerfile` | 3000:3000 | Next.js application |
| `nginx` | nginx:1.27-alpine | 8080:80 | Reverse proxy |
| `app-dev` | node:24-alpine | 3000:3000 | Dev mode (profile: dev) |

**Volumes:**

- `pgdata` -- PostgreSQL data (critical, must be backed up)
- `uploads` -- File uploads at `/app/data/uploads`
- `app_node_modules` -- Dev mode only

**Useful commands:**

```bash
docker compose ps                    # Check running containers
docker compose logs app --tail=100   # App logs
docker compose logs db --tail=100    # Database logs
docker compose restart app           # Restart without rebuild
docker compose up -d --build app     # Rebuild and restart
docker compose down                  # Stop everything (data preserved in volumes)
```

## Environment Variables

### Root `.env` (Docker Compose)

```
DATABASE_URL=postgresql://<db-user>:<password>@db:5432/<db-name>
POSTGRES_USER=<db-user>
POSTGRES_PASSWORD=<password>
POSTGRES_DB=<db-name>
GIT_COMMIT=<set by deploy.sh>
```

### `app/.env.local` (Application bootstrap)

```
NEXTAUTH_SECRET=<random 32+ char string>
NEXTAUTH_URL=https://<your-domain>
APP_ENCRYPTION_KEY=<random 32+ char string; encrypts stored integration keys>

GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
```

All other integration keys (Stripe, Mailchimp, FileMaker, GitHub App, etc.) are
configured at **Admin → Settings → Integrations**, not here.

## Health Check

```bash
curl https://<your-domain>/api/health
```

Returns `{"status":"ok"}` if the app is running and can reach the database.

## Authentication

The system uses Google OAuth via NextAuth. Only users with accounts in the
`User` table can log in; new users are created by an admin in the admin panel.
On a fresh install, the first user is granted admin access until a privileged
user exists.

If authentication stops working:

1. Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `app/.env.local`
2. Verify `NEXTAUTH_URL` matches the production URL
3. Check that the Google OAuth consent screen hasn't expired (Google Cloud Console)
4. Check the authorized redirect URI is set to `https://<your-domain>/api/auth/callback/google`

## Common Problems

### App won't start after deploy

```bash
docker compose logs app --tail=50
```

Usually a build failure or missing env var. Check for TypeScript errors in the log.

### Large import times out

The system supports imports up to 50MB and 5 minutes (300s). If an import exceeds this:

- Split the file into smaller chunks
- Check Nginx timeout settings in `nginx/nginx.conf`

### Database connection refused

```bash
docker compose ps db    # Is it running?
docker compose logs db  # Any errors?
```

If the volume is corrupted, restore from backup.

### "UNIQUE constraint violation" during import

Usually means the data has already been imported. The import endpoints use
upsert logic, but if the unique key has changed between schema versions,
duplicates can occur. Check the specific error message for which table and
constraint.

### Port 5433 conflict

The database is exposed on host port 5433 (not 5432) to avoid conflicts with any
Postgres running natively on the host. If another service claims 5433, update the
port mapping in `docker-compose.yml`.

## Monitoring

Currently manual. Check these periodically:

1. **Health**: `curl https://<your-domain>/api/health`
2. **Disk space**: `df -h` (host storage)
3. **Docker volumes**: `docker system df` (container storage)
4. **Database size**: `docker exec <db-container> psql -U <db-user> -d <db-name> -c "SELECT pg_size_pretty(pg_database_size('<db-name>'));"`

## Development Setup

For local development:

```bash
git clone <your-repo-url> holt
cd holt
cp env.example .env        # Edit with local DB credentials

# Option A: Docker dev mode (recommended)
docker compose --profile dev up

# Option B: Local Node.js
cd app
npm install
npx prisma generate
npm run dev
```

The dev server runs at `http://localhost:3000`. You need a running PostgreSQL
instance (either via Docker or local install).

## Code Quality Checks

Before every commit:

```bash
cd app
npm run validate    # lint + typecheck + format check
npm test            # Jest tests
```

These must pass. The production build skips TypeScript/ESLint checks, so
`validate` is the gate.

## Key Technical Decisions

- **App Router + tRPC** -- feature pages render under `src/app/`; data flows over
  tRPC (react-query). The Pages Router is retained only for `src/pages/api/**` REST
  routes (shared/export/webhook/mutation endpoints) and `auth/login`.
- **Prisma ORM** -- type-safe database access, migration management
- **Host port 5433** -- avoids conflict with a Postgres running natively on the host
- **50MB upload / 300s timeout** -- sized for vendor price book imports (large PDFs)
- **DB-backed integration credentials** -- providers are configured at runtime per
  organization, so one build serves many deployments without env churn
