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

Backups are saved to `backups/` as compressed `.sql.gz` files with timestamps. The script retains the last 30 days of backups automatically.

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

## What the Backup Contains

- All PostgreSQL tables, indexes, constraints, and sequences
- All data (products, pricing, inventory, orders, staff, etc.)
- Prisma migration history (`_prisma_migrations` table)

## What the Backup Does NOT Contain

- Uploaded files (line drawings, inventory photos) -- stored in Docker volume `uploads`
- Application code -- stored in git
- Environment variables (`.env`, `.env.local`) -- stored on the host filesystem
- Host task scheduler / cron configuration
