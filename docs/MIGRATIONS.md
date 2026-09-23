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
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
```

Add `--script` to get the SQL rather than a human-readable summary.

**CI enforces it.** The "Migrations match the schema" step runs that diff with
`--exit-code` against a database built by `migrate deploy`: if the migrations
and `schema.prisma` describe different databases, the build fails. Until
2026-09-23 they did. `schema.prisma` omitted five indexes the migrations build,
and an FK's `onDelete`. So every `migrate dev` proposed dropping the
`LegacyOrder` trigram search indexes, and authors trimmed that out by hand. One
migration's header says Prisma cannot represent `USING gin (... gin_trgm_ops)`.
It can, and the schema now does:

```prisma
@@index([customerName(ops: raw("gin_trgm_ops"))], type: Gin, map: "LegacyOrder_customerName_trgm_idx")
```

A migration that adds an index by hand-written SQL must declare the same index
in `schema.prisma`, with `map:` naming it, or CI goes red.

**The integration test database is built by `db push`, not by migrations**
(`jest.integration.setup.ts`). So anything the schema depends on that only
migration SQL creates is missing there. `db push` then fails, and every
integration file with it. The trigram indexes need the `pg_trgm` extension, so
the harness and `npm run db:push` create it before pushing. Prisma declares
extensions only behind a preview flag. Verify a `schema.prisma` change by
running one integration file locally, not only `migrate deploy`: #194's first
CI run failed exactly this way after the `migrate deploy` check had passed.

Prisma 7 removed `--from-schema-datasource` / `--to-schema-datamodel`; the
datasource now comes from `prisma.config.ts` via `--from-config-datasource`,
and a schema file is `--from-schema` / `--to-schema`. `migrate diff` also no
longer accepts `--shadow-database-url`, and `db execute` no longer accepts
`--url` — export `DATABASE_URL` instead, or pipe the SQL straight to `psql`:

```bash
docker exec -i holt-db-1 psql -U dbuser_fbc -d <db> -v ON_ERROR_STOP=1 \
  < prisma/migrations/<name>/migration.sql
```

### When `migrate dev` wants to reset

If the dev database has drifted, `prisma migrate dev` offers to drop it. Do
not accept — `fbc_dev_db` holds working data. Hand-write the migration SQL
instead, apply it with the `psql` command above, then mark it applied:

```bash
npx prisma migrate resolve --applied <migration_dir_name>
```

`migrate resolve` only records the migration as applied; it does **not** run
the SQL. Apply first, resolve second, and verify the object exists before
moving on — resolving without applying leaves the history lying about the
database.
