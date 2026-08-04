// app/scripts/apply-preset.impl.ts
//
// The real GitOps-door implementation. Not meant to be invoked directly --
// always go through `node scripts/apply-preset.mjs`, which launches this
// file under ts-node with the path-alias loader already wired up (see that
// file's header for why the split exists).
//
// Usage (from app/, via the launcher):
//   node scripts/apply-preset.mjs                          # apply all (config/presets + config/local, local wins)
//   node scripts/apply-preset.mjs --file config/local/saybrook.yaml
//   node scripts/apply-preset.mjs --dry-run                # print the diff, write nothing
//   node scripts/apply-preset.mjs --actor you@example.com  # recorded on the audit trail
//
// Exit code is non-zero if any preset FAILED to apply or any preset file
// was malformed -- a GitOps runner (or a human) should treat this the same
// as any other failed deploy step.
//
// Data safety (CLAUDE.md rule 59): `saybrook`, `holt_saybrook` and
// `akritos` hold restored/seeded tenant data and must never take a preset
// apply by accident -- applying the wrong tenant's config to them is
// exactly the kind of "wrong env" typo rule 59 exists to catch. Writing
// (not dry-running) against any database other than fbc_dev_db requires
// an explicit --yes.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { loadAllPresets, loadPresetFile } from "@/lib/config/presetFiles";
import { applyBundle, applyPreset, type ApplyResult } from "@/lib/config/applyPreset";

const SAFE_DEFAULT_DATABASE = "fbc_dev_db";

interface CliArgs {
  file: string | null;
  dryRun: boolean;
  actor: string | null;
  yes: boolean;
}

function printUsage(): void {
  console.log(`Usage: node scripts/apply-preset.mjs [options]

Applies config presets (config/presets/, config/local/) to the database.

Options:
  --file <path>     Apply only this file, e.g. config/local/saybrook.yaml
  --dry-run         Compute and print the diff; write nothing (not even the audit row)
  --actor <email>   Operator email recorded on the audit trail
  --yes             Required to WRITE to any database other than ${SAFE_DEFAULT_DATABASE}
  --help            Show this message
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { file: null, dryRun: false, actor: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--file":
        args.file = argv[++i] ?? null;
        if (!args.file) {
          console.error("--file requires a path argument");
          process.exit(1);
        }
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--actor":
        args.actor = argv[++i] ?? null;
        if (!args.actor) {
          console.error("--actor requires an email argument");
          process.exit(1);
        }
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }
  return args;
}

/** The database name only -- never the credentials embedded in the URL.
 *  Applying tenant config to the wrong database is the obvious foot-gun
 *  here, so the operator needs to SEE the name before anything writes. */
function resolveDatabaseName(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, "") || "(unnamed database)";
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

function printResult(result: ApplyResult): void {
  const { created, updated, deleted } = result.changes;
  console.log(
    `  [${result.action}] ${result.kind}/${result.name}  created=${created} updated=${updated} deleted=${deleted}`,
  );
  for (const message of result.messages) {
    console.log(`      ${message}`);
  }
}

async function applyOneFile(
  filePath: string,
  args: CliArgs,
  prisma: PrismaClient,
): Promise<{ hadFailure: boolean; hadMalformedFile: boolean }> {
  const loaded = await loadPresetFile(filePath);
  if ("errors" in loaded) {
    console.error(`Malformed preset file ${filePath}:`);
    for (const e of loaded.errors) console.error(`  ${e}`);
    return { hadFailure: false, hadMalformedFile: true };
  }

  console.log(`Applying ${loaded.sourceFile}${args.dryRun ? " (dry run)" : ""}:`);
  const results = await applyBundle(loaded.bundle, {
    source: `cli:${loaded.sourceFile}`,
    actor: args.actor,
    dryRun: args.dryRun,
    prisma,
  });
  for (const result of results) printResult(result);
  return { hadFailure: results.some((r) => r.action === "FAILED"), hadMalformedFile: false };
}

async function applyAll(
  args: CliArgs,
  prisma: PrismaClient,
): Promise<{ hadFailure: boolean; hadMalformedFile: boolean }> {
  const report = await loadAllPresets();

  // A local file silently shadowing a shipped one is exactly the surprise
  // worth printing -- report every override by name before applying.
  if (report.overrides.length) {
    console.log("Local overrides (config/local wins over config/presets):");
    for (const o of report.overrides) {
      console.log(`  ${o.kind}/${o.name}: ${o.localFile} overrides ${o.shippedFile}`);
    }
  }

  let hadMalformedFile = false;
  if (report.errors.length) {
    console.error("Malformed preset file(s) (skipped):");
    for (const e of report.errors) {
      console.error(`  ${e.sourceFile}:`);
      for (const m of e.messages) console.error(`    ${m}`);
    }
    hadMalformedFile = true;
  }

  console.log(`Applying ${report.presets.length} preset(s)${args.dryRun ? " (dry run)" : ""}:`);
  let hadFailure = false;
  for (const loaded of report.presets) {
    const result = await applyPreset(loaded.preset, {
      source: `cli:${loaded.sourceFile}`,
      actor: args.actor,
      dryRun: args.dryRun,
      prisma,
    });
    printResult(result);
    if (result.action === "FAILED") hadFailure = true;
  }

  return { hadFailure, hadMalformedFile };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Export it (or load app/.env.local) before running.");
    process.exit(1);
  }

  const dbName = resolveDatabaseName(process.env.DATABASE_URL);
  console.log(`Target database: ${dbName}`);

  if (!args.dryRun && dbName !== SAFE_DEFAULT_DATABASE && !args.yes) {
    console.error(
      `Refusing to write: DATABASE_URL points at "${dbName}", not "${SAFE_DEFAULT_DATABASE}". ` +
        "saybrook, holt_saybrook and akritos hold restored/seeded data (CLAUDE.md rule 59) -- " +
        "pass --yes to confirm this is the database you mean to change, or --dry-run to preview safely.",
    );
    process.exit(1);
  }

  // Prisma 7 requires the pg driver adapter -- a bare `new PrismaClient()`
  // throws at construction. Mirrors src/lib/prisma.ts and scripts/create-admin.mjs.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  let outcome: { hadFailure: boolean; hadMalformedFile: boolean };
  try {
    outcome = args.file ? await applyOneFile(args.file, args, prisma) : await applyAll(args, prisma);
  } finally {
    await prisma.$disconnect();
  }

  if (outcome.hadFailure || outcome.hadMalformedFile) {
    console.error("\napply-preset: completed with failures.");
    process.exit(1);
  }
  console.log("\napply-preset: done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
