// /app/scripts/seed-coverage.impl.ts
//
// Measures a seeded database against prisma/seed/coverage.ts and fails on any
// disagreement. This is the half of the manifest that needs a real database;
// __tests__/seedCoverage.test.ts covers the static half.
//
// Two failure directions, both of which matter:
//
//   REGRESSION — a model marked `seeded` came back empty. A seed module stopped
//                running, or an exception was swallowed. Without this, the seed
//                quietly hollows out and every empty table still looks normal.
//   STALE      — a model marked `todo` came back populated. Somebody did the
//                work and left the manifest behind, so the remaining-gap list
//                overstates what is left. Move it to `seeded`.
//
// Exit 0 clean, 1 on either. Runs in CI's smoke job, which already builds a
// seeded database, so this costs one query rather than a second seed.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  SEED_COVERAGE,
  SEED_TRANCHES,
  type SeedStatus,
  type Seeder,
} from "../prisma/seed/coverage";

interface Row {
  model: string;
  status: SeedStatus;
  rows: number;
  tranche?: string;
  seeder?: Seeder;
}

/**
 * Seeders that did NOT run, via `--without cms`. Models they own are exempt
 * from the regression check: CI seeds with --no-cms, and calling its three CMS
 * tables a regression on every run would train everyone to ignore this check.
 */
function seedersNotRun(argv: string[]): Set<string> {
  const skipped = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--without" && argv[i + 1]) skipped.add(argv[i + 1]);
  }
  return skipped;
}

async function liveRowCounts(prisma: PrismaClient): Promise<Map<string, number>> {
  // Live counts, not the planner's estimate: n_live_tup in pg_stat_user_tables
  // lags behind ANALYZE and reports 0 for a freshly seeded table often enough to
  // fake a regression. Counting is slower and correct.
  const names = Object.keys(SEED_COVERAGE);
  const counts = new Map<string, number>();
  for (const model of names) {
    try {
      const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${model}"`,
      );
      counts.set(model, Number(r[0]?.n ?? 0));
    } catch {
      // A model in the manifest with no table means migrations are behind the
      // schema. Report it as absent rather than crashing the whole check.
      counts.set(model, -1);
    }
  }
  return counts;
}

function report(rows: Row[], notRun: Set<string>): number {
  const missingTable = rows.filter((r) => r.rows === -1);
  const regressions = rows.filter(
    (r) => r.status === "seeded" && r.rows === 0 && !notRun.has(r.seeder ?? "demo"),
  );
  const notChecked = rows.filter((r) => r.status === "seeded" && notRun.has(r.seeder ?? "demo"));
  const stale = rows.filter((r) => r.status === "todo" && r.rows > 0);
  const seeded = rows.filter((r) => r.status === "seeded" && r.rows > 0);
  const todo = rows.filter((r) => r.status === "todo" && r.rows === 0);
  const skipped = rows.filter((r) => r.status === "skipped");

  console.log(
    `seed coverage: ${seeded.length} seeded, ${todo.length} outstanding, ` +
      `${skipped.length} skipped by design (${rows.length} models)`,
  );

  if (notChecked.length) {
    console.log(
      `  (${notChecked.length} not checked — seeder(s) ${[...notRun].join(", ")} did not run)`,
    );
  }

  console.log("\nremaining work by tranche:");
  for (const tranche of SEED_TRANCHES) {
    const left = todo.filter((r) => r.tranche === tranche).map((r) => r.model);
    if (left.length) console.log(`  ${tranche.padEnd(24)} ${left.length}  ${left.join(", ")}`);
  }

  if (missingTable.length) {
    console.error(
      `\nNO SUCH TABLE (${missingTable.length}) — migrations are behind schema.prisma:`,
    );
    for (const r of missingTable) console.error(`  ${r.model}`);
  }
  if (regressions.length) {
    console.error(`\nREGRESSION (${regressions.length}) — marked seeded, came back empty:`);
    for (const r of regressions) console.error(`  ${r.model}`);
    console.error("  A seed module stopped populating these. Fix the seed, or");
    console.error("  reclassify in prisma/seed/coverage.ts and say why.");
  }
  if (stale.length) {
    console.error(`\nSTALE MANIFEST (${stale.length}) — marked todo, but populated:`);
    for (const r of stale) console.error(`  ${r.model} (${r.rows} rows)`);
    console.error('  The work is done. Move these to { status: "seeded" }.');
  }
  return missingTable.length + regressions.length + stale.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  // Prisma 7 requires the pg driver adapter; a bare `new PrismaClient()`
  // throws at construction. Same shape as scripts/seed-roles.impl.ts.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const counts = await liveRowCounts(prisma);
    const rows: Row[] = Object.entries(SEED_COVERAGE).map(([model, e]) => ({
      model,
      status: e.status,
      tranche: e.tranche,
      seeder: e.seeder,
      rows: counts.get(model) ?? 0,
    }));
    process.exitCode = report(rows, seedersNotRun(process.argv.slice(2)));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
