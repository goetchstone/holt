// app/prisma/testing/practiceCopyDrill.ts
//
// Runs a practice copy's save and Start over for real (GAP-28), on throwaway
// databases it creates from the one DATABASE_URL points at, and drops afterwards.
// It isn't a Jest test because rule 59 keeps other databases out of the test suite,
// and the same reason makes this worth running unattended: nothing else can tell
// whether DROP DATABASE and CREATE DATABASE ... TEMPLATE did what they should. CI
// runs it after the seed (.github/workflows/ci.yml).
//
// Only ever writes to holt_scratch_practice_drill and the two beside it. It reads
// the source database's schema by copying it, and refuses to run if that database
// can't be copied rather than touching it.

import { Client } from "pg";
import { isPracticeDatabaseName } from "../../src/lib/practiceCopy";
import {
  PracticeCopyError,
  readStartingPoint,
  restoreStartingPoint,
  saveStartingPoint,
} from "../../src/lib/practiceCopyDatabase";

const DRILL = "holt_scratch_practice_drill";
const BESIDE_IT = [DRILL, `${DRILL}_start`, `${DRILL}_incoming`];

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`Drill failed: ${what}`);
  console.log(`  ok: ${what}`);
}

async function refuses(what: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt();
  } catch (err) {
    check(err instanceof PracticeCopyError, what);
    return;
  }
  throw new Error(`Drill failed: ${what} (it didn't refuse)`);
}

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is not set.");
  const source = new URL(sourceUrl).pathname.slice(1);
  // The first checks need a name that isn't practice, and a practice source would be
  // saved over for real.
  if (isPracticeDatabaseName(source)) {
    throw new Error(`Point DATABASE_URL at a database not named as practice, not "${source}".`);
  }
  const serverUrl = urlFor(sourceUrl, "postgres");
  const drillUrl = urlFor(sourceUrl, DRILL);

  const dropAll = () =>
    withClient(serverUrl, async (client) => {
      for (const name of BESIDE_IT) {
        await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
      }
    });
  const databases = () =>
    withClient(serverUrl, async (client) => {
      const { rows } = await client.query<{ datname: string }>("SELECT datname FROM pg_database");
      return new Set(rows.map((r) => r.datname));
    });
  const markers = () =>
    withClient(drillUrl, async (client) => {
      const { rows } = await client.query<{ note: string }>(
        "SELECT note FROM drill_marker ORDER BY note",
      );
      return rows.map((r) => r.note).join(",");
    });
  const mark = (note: string) =>
    withClient(drillUrl, (client) =>
      client.query("INSERT INTO drill_marker (note) VALUES ($1)", [note]),
    );

  await dropAll();
  try {
    await refuses("refuses to save a database not named as practice", () =>
      saveStartingPoint(sourceUrl),
    );
    await refuses("refuses to start over a database not named as practice", () =>
      restoreStartingPoint(sourceUrl),
    );
    check(!(await databases()).has(`${source}_start`), "and left nothing beside it");

    await withClient(serverUrl, async (client) => {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [source],
      );
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(DRILL)} TEMPLATE ${client.escapeIdentifier(source)}`,
      );
    });
    await withClient(drillUrl, (client) => client.query("CREATE TABLE drill_marker (note text)"));
    await mark("before");

    check((await readStartingPoint(drillUrl)) === null, "no starting point at first");
    await refuses("refuses to start over with no starting point", () =>
      restoreStartingPoint(drillUrl),
    );
    check((await markers()) === "before", "and the copy is untouched");

    const before = Date.now();
    await saveStartingPoint(drillUrl);
    const savedAt = await readStartingPoint(drillUrl);
    check(
      savedAt !== null &&
        savedAt.getTime() >= before - 1000 &&
        savedAt.getTime() <= Date.now() + 1000,
      "saving records when",
    );
    check(!(await databases()).has(`${DRILL}_incoming`), "and leaves no working copy behind");
    check((await markers()) === "before", "saving leaves the copy as it was");

    await mark("after");
    check((await markers()) === "after,before", "practice work lands in the copy");

    // The app's pool holds connections open when someone presses the button.
    const held = new Client({ connectionString: drillUrl });
    await held.connect();
    let heldDropped = false;
    held.on("error", () => {
      heldDropped = true;
    });
    await restoreStartingPoint(drillUrl);
    check((await markers()) === "before", "starting over brings back the starting point");
    check((await readStartingPoint(drillUrl)) !== null, "and the starting point is still there");
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(heldDropped, "and whoever was connected is dropped rather than blocking it");
    await held.end().catch(() => undefined);

    await mark("second");
    await restoreStartingPoint(drillUrl);
    check((await markers()) === "before", "starting over works a second time");

    await mark("newer");
    await saveStartingPoint(drillUrl);
    await mark("later");
    await restoreStartingPoint(drillUrl);
    check((await markers()) === "before,newer", "saving again replaces the starting point");

    // Someone connecting between clearing out and copying mustn't fail the save: the
    // app's pool reconnects on its next request.
    const busy = setInterval(() => {
      void withClient(drillUrl, (client) => client.query("SELECT 1")).catch(() => undefined);
    }, 5);
    try {
      await saveStartingPoint(drillUrl);
      await restoreStartingPoint(drillUrl);
    } finally {
      clearInterval(busy);
    }
    check((await markers()) === "before,newer", "saving and starting over cope with a busy app");
    console.log("Practice copy drill passed.");
  } finally {
    await dropAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
