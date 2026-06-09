// /app/jest.integration.setup.ts
//
// Jest globalSetup for the `integration` project. Runs ONCE before
// any integration test. Two responsibilities:
//
//   1. Ensure the test database exists (create if missing).
//   2. Apply all migrations against it via `prisma migrate deploy`.
//
// After this runs, the test workers can import `prisma` from
// `lib/prisma` and the connection points at the migrated test DB
// (because globalSetup mutates process.env.DATABASE_URL and worker
// processes inherit it).
//
// Phase 0.6.1 (2026-04-30) — first iteration. Future tightening
// tracked in plan file: connection pool tuning, parallel-worker
// support, faster reset via per-test transaction-rollback.

import { execSync } from "child_process";
import { Client } from "pg";

const TEST_DB_NAME = "fbc_test_db";

/**
 * Build the DATABASE_URL for the test database from the dev DB url
 * (which lives in .env / docker compose). We swap just the database
 * name so the host / port / user / password stay correct in any
 * environment (local docker, CI postgres service, devcontainer).
 *
 * Pool size is pinned to 1. With multiple connections in the pool,
 * sequential awaits in a test can land on different connections —
 * the second connection doesn't always see the first's just-committed
 * write under the default READ COMMITTED isolation. That surfaced as
 * `SalesOrder_customerId_fkey` violations even though the customer was
 * created on the line above. Pool=1 serializes through one connection
 * so writes are immediately visible to the next read.
 */
function buildTestDbUrl(): string {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      "DATABASE_URL must be set for integration tests. " +
        "Locally: source .env or run via `docker compose exec`. " +
        "In CI: set DATABASE_URL in the workflow env block.",
    );
  }
  // Swap the database name and append connection-pool tuning. The
  // tuning is appended to whatever query string is already there.
  const swapped = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB_NAME}$1`);
  const sep = swapped.includes("?") ? "&" : "?";
  return `${swapped}${sep}connection_limit=1&pool_timeout=10`;
}

/**
 * Connect to the postgres system database (template1) and CREATE
 * DATABASE if `fbc_test_db` doesn't exist. Idempotent.
 */
async function ensureTestDbExists(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL!;
  // Connect to `postgres` system DB — every Postgres instance has it.
  const adminUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const result = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      TEST_DB_NAME,
    ]);
    if (result.rowCount === 0) {
      // template0 is the safe template — bypasses any collation-version
      // weirdness in template1 that the dev container sometimes hits.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.query(`CREATE DATABASE "${TEST_DB_NAME}" TEMPLATE template0`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Push the current Prisma schema directly to the test database via
 * `prisma db push`. Faster + cleaner than `migrate deploy` for tests:
 *
 *   - `migrate deploy` replays every historical migration. Our first
 *     migration (20250213_schema_redesign) was authored against a
 *     pre-existing prod DB and isn't replayable from scratch.
 *   - `db push` just applies the current schema.prisma. Tests only
 *     care about "the schema as it exists today," not the historical
 *     trail.
 *
 * `--accept-data-loss` is safe here because the test DB has no data
 * worth keeping between runs. `--skip-generate` skips re-generating
 * the Prisma client (we already have one from `npx prisma generate`).
 */
function applySchema(testDbUrl: string): void {
  execSync("npx prisma db push --accept-data-loss", {
    cwd: __dirname,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set before running integration tests. " +
        "Try: DATABASE_URL='postgresql://dbuser_fbc:password@localhost:5433/fbc_dev_db' npm run test:integration",
    );
  }

  await ensureTestDbExists();

  const testDbUrl = buildTestDbUrl();
  applySchema(testDbUrl);

  // Worker processes inherit env, so this swap routes every prisma
  // import in the workers at the test DB.
  process.env.DATABASE_URL = testDbUrl;
}
