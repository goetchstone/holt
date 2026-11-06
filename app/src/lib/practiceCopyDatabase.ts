// /app/src/lib/practiceCopyDatabase.ts
//
// A practice copy's starting point, and going back to it (GAP-28).
//
// The starting point is a second database beside the copy's own, <name>_start, made
// with CREATE DATABASE ... TEMPLATE. A dump file would hold the store's real costs
// somewhere on disk that needs protecting, and would need a volume of its own. A
// template lives where the copy's data already does, and copying one either finishes
// or leaves nothing behind.
//
// Going back builds the new database first and only then drops the old one, so a
// failed copy leaves the practice copy as it was.
//
// Both are destructive, so both refuse any database whose name doesn't say it's
// practice (principle 8), here at the lowest level as well as in the route. They
// connect to the server's maintenance database, since a database can't be copied or
// dropped from inside itself, and so need a role that may create databases. That's
// the default in docker-compose.yml.
//
// Exercised against a real server by prisma/testing/practiceCopyDrill.ts in CI,
// because it creates and drops databases, which rule 59 keeps out of the test suite.

import { Client } from "pg";
import { logError } from "@/lib/logger";
import { databaseNameFromUrl, isPracticeDatabaseName } from "@/lib/practiceCopy";

/** Something the person can act on. The message is safe to show them. */
export class PracticeCopyError extends Error {}

const POSTGRES_NAME_LIMIT = 63;
const PLAIN_NAME = /^[A-Za-z0-9_]+$/;
/** Postgres: another session is using the database. */
const OBJECT_IN_USE = "55006";
/** Postgres: this role isn't allowed to. */
const INSUFFICIENT_PRIVILEGE = "42501";

interface PracticeNames {
  copy: string;
  start: string;
  incoming: string;
}

function namesFor(databaseUrl: string): PracticeNames {
  const copy = databaseNameFromUrl(databaseUrl);
  if (!isPracticeDatabaseName(copy) || !PLAIN_NAME.test(copy)) {
    throw new PracticeCopyError(
      `Refusing to touch database "${copy}": its name doesn't say it's a practice copy.`,
    );
  }
  const names = { copy, start: `${copy}_start`, incoming: `${copy}_incoming` };
  if (names.incoming.length > POSTGRES_NAME_LIMIT) {
    throw new PracticeCopyError(
      `The database name "${copy}" is too long to keep a copy beside it.`,
    );
  }
  return names;
}

function postgresCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

async function onServer<T>(
  databaseUrl: string,
  work: (client: Client, quote: (name: string) => string) => Promise<T>,
): Promise<T> {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  // With no listener, a connection lost mid-way would take the whole server down.
  client.on("error", (err) => logError("Practice copy's server connection failed", err));
  await client.connect();
  try {
    return await work(client, (name) => client.escapeIdentifier(name));
  } catch (err) {
    if (postgresCode(err) === INSUFFICIENT_PRIVILEGE) {
      throw new PracticeCopyError(
        "The practice copy's database user isn't allowed to create databases, which saving and starting over need.",
      );
    }
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * A template can't have anyone connected. Postgres blocks new connections while it
 * copies and waits a few seconds for the ones it finds to finish. So this fails only
 * if someone connects in the moment between clearing them out and starting the copy,
 * and then stays connected. Rare enough that pressing the button again is the answer.
 */
async function copyDatabase(
  client: Client,
  quote: (name: string) => string,
  from: string,
  to: string,
): Promise<void> {
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [from],
  );
  try {
    await client.query(`CREATE DATABASE ${quote(to)} TEMPLATE ${quote(from)}`);
  } catch (err) {
    if (postgresCode(err) === OBJECT_IN_USE) {
      throw new PracticeCopyError("Someone connected at just that moment. Try again.");
    }
    throw err;
  }
}

/** When the starting point was saved, or null if there isn't one. */
export async function readStartingPoint(databaseUrl: string): Promise<Date | null> {
  const { start } = namesFor(databaseUrl);
  return onServer(databaseUrl, async (client) => {
    const { rows } = await client.query<{ savedAt: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS "savedAt" FROM pg_database WHERE datname = $1`,
      [start],
    );
    if (rows.length === 0) return null;
    return new Date(rows[0].savedAt ?? 0);
  });
}

/** Keep the copy as it stands now as what Start over goes back to. Connections drop. */
export async function saveStartingPoint(databaseUrl: string): Promise<void> {
  const { copy, start, incoming } = namesFor(databaseUrl);
  await onServer(databaseUrl, async (client, quote) => {
    await client.query(`DROP DATABASE IF EXISTS ${quote(incoming)}`);
    await copyDatabase(client, quote, copy, incoming);
    await client.query(`DROP DATABASE IF EXISTS ${quote(start)}`);
    await client.query(`ALTER DATABASE ${quote(incoming)} RENAME TO ${quote(start)}`);
    await client.query(
      `COMMENT ON DATABASE ${quote(start)} IS ${client.escapeLiteral(new Date().toISOString())}`,
    );
  });
}

/**
 * Put the copy back as it was when the starting point was saved. Everything since
 * goes, including anyone's connection to it. The caller brings the result up to the
 * running version, since the starting point may predate the last upgrade.
 */
export async function restoreStartingPoint(databaseUrl: string): Promise<void> {
  const { copy, start, incoming } = namesFor(databaseUrl);
  await onServer(databaseUrl, async (client, quote) => {
    const saved = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [start]);
    if (saved.rowCount === 0) {
      throw new PracticeCopyError("There's no starting point yet. Save one first.");
    }
    await client.query(`DROP DATABASE IF EXISTS ${quote(incoming)}`);
    await copyDatabase(client, quote, start, incoming);
    await client.query(`DROP DATABASE ${quote(copy)} WITH (FORCE)`);
    await client.query(`ALTER DATABASE ${quote(incoming)} RENAME TO ${quote(copy)}`);
  });
}
