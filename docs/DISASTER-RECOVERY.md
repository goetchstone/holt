# Disaster Recovery

## Recovery Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RPO** (Recovery Point Objective) | 24 hours | Daily automated backups via host task scheduler |
| **RTO** (Recovery Time Objective) | ~15 minutes | Restore from backup + container restart |

## Automated Backups

### Setup

Schedule `scripts/backup-db.sh` to run daily (e.g. via cron or your host's task scheduler):

```
# Example cron entry — runs at 2:00 AM, adjust path to your deploy root:
0 2 * * * <deploy-path>/scripts/backup-db.sh <deploy-path>/backups
```

Enable failure notifications via your preferred alerting channel.

### Manual Backup

```bash
./scripts/backup-db.sh
```

Backups are saved to `backups/` as compressed `db-backup-*.sql.gz` files with
timestamps. The script prunes backups older than `RETENTION_DAYS` (default 14;
override via env). **Ship at least one copy off-box** — a backup that lives only
on the host it protects is lost with the host.

### Uploaded files (separate backup)

The SQL dump does **not** contain uploaded files (ticket attachments, inventory
photos, vendor line drawings) — they live in the `uploads` Docker volume mounted
at `/app/data/uploads`. Back them up with the companion script, scheduled right
after the DB backup:

```bash
./scripts/backup-uploads.sh
```

This writes `backups/uploads-backup-*.tgz` from the `holt_uploads` volume (no app
container needed) and prunes on the same `RETENTION_DAYS` window. For a
non-Docker deployment set `UPLOADS_DIR=/path/to/uploads` instead.

```
# Example cron — DB at 02:00, uploads at 02:10:
0  2 * * * <deploy-path>/scripts/backup-db.sh      >> <deploy-path>/backups/backup.log 2>&1
10 2 * * * <deploy-path>/scripts/backup-uploads.sh >> <deploy-path>/backups/backup.log 2>&1
```

### Before Any Migration

Always run a manual backup before applying migrations:

```bash
./scripts/backup-db.sh
```

## Restore Procedure

### Step-by-Step

```bash
# 1. List available backups
ls -la backups/

# 2. Restore (will prompt for confirmation)
./scripts/restore-db.sh backups/<db-name>_20260324_120000.sql.gz
```

The restore script will:

1. Stop the app container
2. Drop and recreate the database
3. Restore from the backup file
4. Restart the app container
5. Verify table count and health endpoint

### Testing a Restore (Non-Destructive)

To test without affecting production, restore to a different database:

```bash
docker exec <db-container> psql -U <db-user> -d postgres \
  -c "CREATE DATABASE test_restore OWNER <db-user>;"

gunzip -c backups/<db-name>_20260324_120000.sql.gz | \
  docker exec -i <db-container> psql -U <db-user> -d test_restore

# Verify table count
docker exec <db-container> psql -U <db-user> -d test_restore \
  -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public';"

# Clean up
docker exec <db-container> psql -U <db-user> -d postgres \
  -c "DROP DATABASE test_restore;"
```

### Restoring uploaded files

```bash
# Restore the uploads tarball back into the holt_uploads volume.
docker run --rm \
  -v holt_uploads:/to \
  -v "$(pwd)/backups":/from \
  alpine sh -c "cd /to && tar xzf /from/uploads-backup-<timestamp>.tgz"
```

## Restore drill (go-live gate)

A backup you have never restored is a hope, not a backup. **Before taking real
money, restore the latest backup into a scratch DB and boot the app against it**
— this is the `docs/PRODUCTION.md` "backups + one restore drilled" gate.

```bash
# 1. Restore the newest DB backup into a scratch database (non-destructive).
docker exec <db-container> psql -U <db-user> -d postgres \
  -c "CREATE DATABASE drill_restore OWNER <db-user>;"
gunzip -c backups/db-backup-<timestamp>.sql.gz | \
  docker exec -i <db-container> psql -U <db-user> -d drill_restore

# 2. Restore the newest uploads backup into a scratch dir and eyeball a file.
mkdir -p /tmp/drill-uploads && tar xzf backups/uploads-backup-<timestamp>.tgz -C /tmp/drill-uploads
ls -R /tmp/drill-uploads | head

# 3. Point a throwaway app at the scratch DB and confirm it boots + is ready.
#    (same APP_ENCRYPTION_KEY as prod, so IntegrationCredential rows decrypt)
DATABASE_URL=postgresql://<db-user>:<pw>@localhost:5433/drill_restore \
  npm run start &  # or `docker compose run` with the env override
curl -s "http://localhost:3000/api/health?ready=1"   # expect 200, settings:"ok"

# 4. Tear down.
docker exec <db-container> psql -U <db-user> -d postgres -c "DROP DATABASE drill_restore;"
rm -rf /tmp/drill-uploads
```

Record the drill date in your runbook; re-drill after any backup-script change.

## Encryption-key (`APP_ENCRYPTION_KEY`) loss & rotation

`APP_ENCRYPTION_KEY` decrypts every `IntegrationCredential` (Stripe, SMTP, OAuth,
…). It is **env-only and never in a backup** (see `docs/SECRETS.md`). Two cases:

- **Key lost (no copy in your secret manager):** the ciphertext in the DB is
  unrecoverable. Recovery = set a fresh `APP_ENCRYPTION_KEY`, then **re-enter every
  integration credential** in Settings → Integrations. Platform secrets
  (`DATABASE_URL`, `NEXTAUTH_SECRET`, Stripe platform key) are unaffected — they
  live in env. No data is lost beyond the stored third-party keys.
- **Planned rotation (key still known):** there is no automated re-encrypt
  script today. Rotate by, for each provider, re-saving its credential in
  Settings → Integrations under the **new** key after it is set (each save
  re-encrypts with the active key). Do this in one maintenance window so no
  credential is left encrypted under the old key. `KEY_SALT` in
  `lib/secretCrypto.ts` is **frozen** — never change it; it would invalidate all
  existing ciphertext.

> A future `scripts/rotate-encryption-key.mjs` (decrypt-with-old →
> encrypt-with-new in one pass) is tracked but not built; until then rotation is
> the manual re-save above.

## What the Backup Contains

- All PostgreSQL tables, indexes, constraints, and sequences
- All data (products, pricing, inventory, orders, staff, etc.)
- Prisma migration history (`_prisma_migrations` table)
- `IntegrationCredential` ciphertext — **useless without `APP_ENCRYPTION_KEY`**

## What the Backup Does NOT Contain

- Uploaded files — backed up separately via `scripts/backup-uploads.sh` (above)
- Application code -- stored in git
- Environment variables (`.env`, `.env.local`) incl. `APP_ENCRYPTION_KEY` -- on the host / secret manager
- Host task scheduler / cron configuration
