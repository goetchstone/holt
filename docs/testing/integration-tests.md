# Integration Tests — Phase 0.6

Postgres-backed integration tests for the ERP. Live in
`app/__tests__/integration/`. Run via `npm run test:integration` from
the `app/` directory.

## Why

Mocked-Prisma tests verify wiring (the right method gets called with
the right args). They don't verify SQL behavior — filter matching,
FK constraint resolution, enum drift, query result shapes. Every
production bug shipped in April 2026 (sales import outage, balance
double-multiplication, salesperson FK-null, impersonation cookie
format) was the second class. Mocks never caught any of them.

Phase 0.6.3+ converts the C+ mocked tests to A/B integration tests on
this harness.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  npm run test:integration                                   │
│    └─ scripts/run-integration-tests.sh                      │
│         └─ for each *.integration.test.ts file:             │
│              jest --selectProjects integration              │
│                   --testPathPatterns <file>                 │
│                                                             │
│  Per-file invocation (PR #181) — without it, multiple       │
│  files in one Jest worker deadlock during the beforeEach    │
│  TRUNCATE because ACCESS EXCLUSIVE locks pile up across     │
│  pg.Pool connections. Per-file gives each file its own      │
│  pool and clean exit. Overhead: ~200ms per file.            │
│                                                             │
│  globalSetup (jest.integration.setup.ts) — runs ONCE per    │
│  Jest invocation:                                           │
│    1. ensureTestDbExists() — connects to `postgres` admin   │
│       DB, CREATEs `fbc_test_db` if missing                  │
│    2. applySchema() — runs `prisma db push` against test DB │
│       (idempotent — no-op if schema already in sync)        │
│    3. swaps process.env.DATABASE_URL to the test DB so      │
│       worker processes inherit it                           │
│                                                             │
│  Per-test (in test files):                                  │
│    beforeEach: resetTestDb() — TRUNCATE every table         │
│    test body: build fixtures via prisma, run code,          │
│               assert on what's in the DB                    │
│    afterAll: prisma.$disconnect() — clean Jest exit         │
└─────────────────────────────────────────────────────────────┘
```

## Conventions

### Test file naming

`*.integration.test.ts` — the `.integration.` infix makes the file's
purpose visible in editor tabs and search results, and double-checks
that someone hasn't accidentally placed a unit test in the
integration directory.

### Test structure

```ts
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

describe("my behavior", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does the thing", async () => {
    // Arrange — build fixtures via the same prisma instance
    await prisma.salesOrder.create({ data: { ... } });

    // Act — exercise the real production code
    const result = await myFunctionUnderTest();

    // Assert — observe via prisma OR the function's return value
    expect(result).toEqual(...);
  });
});
```

### Fixture conventions

- Build the **minimum** fixtures the assertion needs. A test that
  requires a vendor + customer + order + 2 line items is fine; a test
  that creates 50 of each is fragile.
- Use **literal IDs only when necessary** — let Postgres auto-assign
  via the `serial` PK. Capture the returned object's `.id` for refs.
- For complex relational fixtures, use Prisma's nested-create syntax
  (see the proof-of-concept test). It's atomic and readable.

### Safety guard

`resetTestDb()` REFUSES to run unless `DATABASE_URL` contains the
literal string "test". A misconfigured runner pointed at dev or prod
will throw, not silently TRUNCATE the wrong database.

## Running locally

```bash
cd app

# One-time: ensure the test DB exists
docker exec furniture-configurator-db-1 psql -U dbuser_fbc -d postgres \
  -c "CREATE DATABASE fbc_test_db OWNER dbuser_fbc TEMPLATE template0;"

# Run integration tests
DATABASE_URL='postgresql://dbuser_fbc:<password>@localhost:5433/fbc_dev_db' \
  npm run test:integration
```

The DATABASE_URL points at the dev DB; globalSetup swaps the path
segment to `fbc_test_db` automatically. Use the dev URL so credentials
and host stay correct.

If the test DB gets into a bad state (e.g. an interrupted `db push`
half-applied a schema change), drop it and rerun:

```bash
docker exec furniture-configurator-db-1 psql -U dbuser_fbc -d postgres \
  -c "DROP DATABASE IF EXISTS fbc_test_db;"
```

globalSetup will recreate it on the next run.

## Running in CI

`.github/workflows/ci.yml` defines a `postgres:17.9-alpine` service
container. CI step `Run real-DB integration tests` invokes
`npm run test:integration` against it. No additional setup needed.

## When to add an integration test vs a unit test

| Test type | When |
|---|---|
| **Unit test (pure)** | Math, formatters, string helpers, anything with no I/O. Always preferred when applicable. |
| **Source-text tripwire (B-)** | Asserting a convention (e.g. "every aggregation file imports the cancelled-line filter"). Catches removal of code, doesn't catch behavior. |
| **Mocked-Prisma orchestration (C+)** | Acceptable as an interim placeholder while an integration version is being written. Must declare `// PLACEHOLDER TEST — Grade: C+` in the file header (`__tests__/testGrading.test.ts` enforces this). |
| **Postgres integration (B/A)** | Anything that touches a Prisma query that depends on schema behavior — filters, joins, FK constraints, enum matching, transaction semantics. The default for new SQL-touching code. |

## Conversion pattern (C+ → B/A)

When converting a placeholder mocked test:

1. Create a sibling integration file at `__tests__/integration/<name>.integration.test.ts`.
2. Port each mocked scenario to use real fixtures + real Prisma.
3. Add at least one **integration-only** scenario the mock structurally couldn't test (FK behavior, date window edge, enum drift, transaction semantics). Phase 0.6 conversions all do this — it's where the value is.
4. Slim the original file to the A-grade pure-helper sections only. Update the file header to point at the integration file.
5. Run `npm run test:integration` — confirm all 16+ pass.
6. Coverage gate may need a small downward bump per the ratchet doctrine since mocked-orchestration coverage moves from the unit project to the integration project (which the gate doesn't currently merge — Phase 0.6.5 fixes that).

Existing conversions to model from: PR #179 (quotesReconcile), PR #181 (dailyReconciliation).

## What's covered today (as of 2026-05-01)

| File | Tests | Phase |
|---|---|---|
| `cancelledLineFilter.integration.test.ts` | 2 | 0.6.1 (proof of concept) |
| `quotesReconcile.integration.test.ts` | 6 | 0.6.3 (PR #179) |
| `dailyReconciliation.integration.test.ts` | 8 | 0.6.3 (PR #181) |

**Total: 16 tests.**

Remaining 0.6.3 placeholders: `journalEntry` orchestration, `mailchimpAudienceSync.runner`, `mailchimpLeadIngestor`, `opportunityTiles`, `leadHousekeeping`. Each can be converted independently in its own PR.

## Gotchas

### TRUNCATE deadlocks under multi-file Jest workers

Surfaced in PR #181 when adding the second integration file. With `maxWorkers: 1` and multiple test files in one worker, the `beforeEach` TRUNCATE in file B deadlocks against pg.Pool connections that file A's last test was still releasing. Fix: per-file Jest invocation via `scripts/run-integration-tests.sh` — each file gets its own pool. Don't merge files into one Jest invocation.

### PrismaPg pool size

`PrismaPg` passes config to `pg.Pool`, which honors `max` (not `connection_limit`). The URL query string `?connection_limit=1` is ignored by the pg driver. To override pool size, set `PG_POOL_MAX` in env — `lib/prisma.ts` reads it at adapter init.

### `prisma migrate deploy` doesn't replay from scratch

The first migration in `app/prisma/migrations/` (`20250213_schema_redesign`) was authored against a pre-existing prod DB and isn't replayable from an empty schema. globalSetup uses `prisma db push --accept-data-loss` instead — applies the current schema directly. Tests don't care about migration history.

### Sharing the prisma singleton across test files

Each test file imports `prisma` from `@/lib/prisma`. With per-file Jest invocation (above), each file gets its own Node process, its own module registry, its own singleton, its own pool. `afterAll(() => prisma.$disconnect())` is fine to keep — it's per-file scope only.

If you ever revert to a multi-file-per-worker setup, remove the `$disconnect` calls — disconnecting the singleton in file A makes file B's tests query a closed connection and silently get empty results.

### Raw-SQL migrations (triggers, functions, indexes) don't land via `prisma db push`

`prisma db push` syncs the model graph from `schema.prisma` but skips files in `prisma/migrations/`. Triggers, custom functions, and indexes defined as raw SQL therefore aren't on the test DB even though the model graph matches prod.

If your test depends on raw SQL behavior (e.g. the B6 payment-delete trigger), replay the migration file in `beforeAll` using `pg.Client` directly — `prisma.$executeRawUnsafe` splits on the first semicolon and breaks `$$ ... $$` function bodies. Pattern:

```ts
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../prisma/migrations/20260428_payment_delete_immutability_trigger/migration.sql",
);

beforeAll(async () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
});
```

This makes the test a literal integration check of the migration file we ship — if the SQL doesn't parse against Postgres, the suite fails before any scenario runs. See `__tests__/integration/paymentDeleteImmutability.integration.test.ts`.

A future improvement is to teach the harness to apply every "pure DDL" migration automatically. Today the per-test pattern is fine because there are only a handful of such migrations.
