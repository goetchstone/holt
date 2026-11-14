// /app/__tests__/hostScriptGuards.test.ts
//
// The refusals at the top of the host's own scripts, run for real in a shell.
// Each one stops before the script touches Docker or a database, so these run
// with neither.
//
//   - scripts/_bundled-db.sh (backup-db.sh, restore-db.sh): both scripts reach
//     only the compose `db` container. With DATABASE_URL on a managed Postgres,
//     a backup dumped the empty local database and reported a good backup.
//   - scripts/deploy.sh: an nginx/nginx.conf kept from before app processes
//     could be several (operators edit that tracked file to put their domain
//     in) went live without the shared upstream, and nothing said so.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const GUARD = path.join(REPO, "scripts/_bundled-db.sh");
const DEPLOY = path.join(REPO, "scripts/deploy.sh");

function bundledDb(env: Record<string, string>, cwd = tmpdir()) {
  return spawnSync("sh", ["-c", `. "${GUARD}"; require_bundled_db`], {
    cwd,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

describe("require_bundled_db (backup-db.sh, restore-db.sh)", () => {
  it.each([
    "postgresql://holt:pw@db:5432/holt?connection_limit=20&pool_timeout=10",
    "postgresql://holt:pw@db/holt",
    "postgres://holt@localhost:5433/holt",
    "postgresql://holt:pw@127.0.0.1:5433/holt",
    "postgresql://holt:pw@db:5432/holt?options=a@b",
  ])("lets the bundled database through: %s", (url) => {
    expect(bundledDb({ DATABASE_URL: url }).status).toBe(0);
  });

  it.each([
    "postgresql://holt:pw@pg-primary.example-cloud.test:5432/holt",
    "postgresql://holt:p%40ss@10.0.4.12:5432/holt",
    "postgresql://holt:pw@db.internal:5432/holt",
  ])("refuses a database outside the stack, saying why: %s", (url) => {
    const run = bundledDb({ DATABASE_URL: url });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/not this stack's own 'db' service/);
  });

  it("reads the root .env when the environment has no DATABASE_URL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "holt-guard-"));
    try {
      writeFileSync(
        path.join(dir, ".env"),
        'POSTGRES_DB=holt\nDATABASE_URL="postgresql://holt:pw@pg.example-cloud.test:5432/holt"\n',
      );
      expect(bundledDb({}, dir).status).toBe(1);
      writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgresql://holt:pw@db:5432/holt\n");
      expect(bundledDb({}, dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is sourced by both scripts before they look for the container", () => {
    for (const script of ["backup-db.sh", "restore-db.sh"]) {
      const text = readFileSync(path.join(REPO, "scripts", script), "utf8");
      const guard = text.indexOf("require_bundled_db || exit 1");
      expect({ script, guarded: guard > 0 }).toEqual({ script, guarded: true });
      const lookup = text.search(/^(DB_)?CONTAINER=.*docker compose ps -q db/m);
      expect(lookup).toBeGreaterThan(0);
      expect(guard).toBeLessThan(lookup);
    }
  });
});

describe("deploy.sh's nginx.conf check", () => {
  /** Run deploy.sh in a scratch directory holding only nginx/nginx.conf. With
   *  no scripts/ there, a run that passes the check stops at step 1's backup
   *  ("No such file") before anything reaches Docker. */
  function deployWith(nginxConf: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "holt-deploy-"));
    try {
      mkdirSync(path.join(dir, "nginx"));
      writeFileSync(path.join(dir, "nginx/nginx.conf"), nginxConf);
      return spawnSync("bash", [DEPLOY], {
        cwd: dir,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
        encoding: "utf8",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const current = readFileSync(path.join(REPO, "nginx/nginx.conf"), "utf8");

  it("refuses an nginx.conf from before the shared upstream, before step 1", () => {
    const old = current
      .replace("include /etc/nginx/app-upstream.conf;", "")
      .replace(/REPLACE_ME_DOMAIN/g, "shop.example.test");
    const run = deployWith(old);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/older than this version of Holt/);
    expect(run.stdout).not.toMatch(/\[1\/5\]/);
  });

  it("refuses one whose domain was never filled in", () => {
    const run = deployWith(current);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/still contains REPLACE_ME_DOMAIN/);
  });

  it("lets the current file, with a domain, through to step 1", () => {
    const run = deployWith(current.replace(/REPLACE_ME_DOMAIN/g, "shop.example.test"));
    expect(run.stdout).toMatch(/\[1\/5\] Pre-deploy database backup/);
  });
});
