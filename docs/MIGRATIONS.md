# Database Migrations

## How Prisma Migrations Work Here

Prisma manages schema changes via SQL migration files in `app/prisma/migrations/`. Each migration directory contains a `migration.sql` file with the DDL statements. Prisma tracks applied migrations in the `_prisma_migrations` table.

Migrations are **forward-only**. Prisma does not support down migrations. Rollback means restoring from a backup taken before the migration.

## Pre-Migration Checklist

1. **Backup the database**: `./scripts/backup-db.sh`
2. **Test the migration SQL** against a copy of production data (see Disaster Recovery doc)
3. **Review the migration SQL** manually -- check for data-destructive operations (DROP, TRUNCATE, ALTER TYPE)
4. **Verify no active users** -- coordinate with staff before applying schema changes

## Applying a Migration

### Development

```bash
cd app
npx prisma migrate dev --name descriptive_name
```

This auto-generates and applies the migration, then regenerates the Prisma client.

### Production

```bash
# Dry run first
./scripts/migrate-prod-db.sh --dry-run app/prisma/migrations/YYYYMMDD_name/migration.sql

# Apply
./scripts/migrate-prod-db.sh app/prisma/migrations/YYYYMMDD_name/migration.sql
```

The script will:

1. Verify the database container is reachable
2. Run a backup via `backup-db.sh`
3. Apply the migration SQL
4. Report table count for verification
5. Print next steps (db pull, generate, resolve, rebuild)

After the script completes:

```bash
cd app
npx prisma db pull            # Verify schema matches
npx prisma generate           # Regenerate client
npx prisma migrate resolve --applied YYYYMMDD_name
docker compose up -d --build app
curl http://localhost:3000/api/health
```

## Rolling Back

Prisma has no `migrate down`. The rollback procedure is:

1. Restore the database from the pre-migration backup (see DISASTER-RECOVERY.md)
2. Revert the code that depends on the new schema
3. Rebuild and restart the app

## Rules

- **Never modify a migration file after it has been applied** to any environment
- **Always create new migrations** for schema changes
- **Name migrations descriptively**: `YYYYMMDD_add_seat_arm_height`, not `YYYYMMDD_fix`
- **Keep migrations small** and focused on one logical change

## The 300-Second Transaction Timeout

Large import operations (wholesale pricing, fabric catalogs) use Prisma `$transaction()` with a 300-second timeout. This is configured in the import API handlers, not in the migration system. If a migration takes more than a few seconds, it likely needs review.

## Schema Drift Detection

To check if the database schema matches the Prisma schema:

```bash
cd app
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma
```
