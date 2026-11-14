// /app/__tests__/databaseRestoreGuards.test.ts
//
// The admin restore endpoint's guards, tested at the level that matters: does
// a bad upload reach `DROP SCHEMA public CASCADE`?
//
// The endpoint used to pipe the request body straight into psql, so the drop
// ran BEFORE anything inspected the upload. A truncated download, a wrong file,
// or a dropped connection destroyed the database and left nothing to restore
// from. It then reported "Database restored successfully" whenever psql exited
// 0 -- and psql exits 0 despite ERROR lines unless ON_ERROR_STOP is set.
//
// psql is mocked: spawning a real one would test Postgres, not the ordering.
// What is asserted is which commands were spawned and in what order, because
// "we did not drop the schema" is the property under test.

import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const spawned: Array<{ args: string[]; stdinChunks: string[] }> = [];

// Pass-through that records where each upload was spooled, so the test can
// look at the real directory the route used.
const mockSpools: Array<{ path: string; dirModeWhileSpooling: number }> = [];
jest.mock("@/lib/privateTempFile", () => {
  const actual = jest.requireActual("@/lib/privateTempFile");
  const fs = jest.requireActual("node:fs");
  const nodePath = jest.requireActual("node:path");
  return {
    createPrivateTempFile: async (prefix: string, filename: string) => {
      const tmp = await actual.createPrivateTempFile(prefix, filename);
      const dirModeWhileSpooling = fs.statSync(nodePath.dirname(tmp.path)).mode;
      mockSpools.push({ path: tmp.path, dirModeWhileSpooling });
      return tmp;
    },
  };
});

// Recording it goes to the database, and this suite has none: left real, the failed
// write logged after the suite ended, and Jest failed a run whose tests all passed.
jest.mock("@/lib/audit", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));

// What ran, in order: each psql (spawn) and the Prisma CLI (execFile), so a test
// can see the migrations run after the restore and not before it.
const ran: string[] = [];
// The migrations' outcome for the next restore; null is success.
let mockMigrateError: Error | null = null;

// After a restore the route brings the database up to date: migrations
// (execFile), then the built-in roles and every process's caches. This suite has
// no database, so those two are stubbed.
// A failure is logged; the recorder behind logError writes to a database this
// suite does not have.
jest.mock("@/lib/logger", () => ({
  logError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@/lib/auth/builtInRoles", () => ({ syncBuiltInRoles: jest.fn(async () => {}) }));
jest.mock("@/lib/cacheGeneration", () => ({ bumpAllCacheGenerations: jest.fn(async () => {}) }));

// One factory for both spellings: restore.ts imports "child_process" and
// lib/databaseReplaced.ts "node:child_process".
function mockChildProcess() {
  return {
    execFile: jest.fn(
      (file: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        ran.push(`${file} ${args.join(" ")}`);
        cb(mockMigrateError);
      },
    ),
    spawn: jest.fn((_cmd: string, args: string[]) => {
      const record = { args, stdinChunks: [] as string[] };
      spawned.push(record);
      ran.push("psql");

      const proc = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stderr: PassThrough;
      };
      proc.stdin = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin.on("data", (c: Buffer) => record.stdinChunks.push(c.toString()));
      // Resolve on the next tick, as a real close event would.
      setImmediate(() => proc.emit("close", 0));
      return proc;
    }),
  };
}
jest.mock("child_process", () => mockChildProcess());
jest.mock("node:child_process", () => mockChildProcess());

jest.mock("@/lib/auth/requireAuth", () => ({
  // Bypass auth; enforcement is covered by roleDecision.test.ts,
  // permissionResolver.test.ts and the apiRouteAuthorization tripwire.
  // Both guards are stubbed because a route may be on either while the
  // enum-to-permission sweep is in progress — mocking only the one this route
  // happens to use today turns a guard swap into an unrelated test failure.
  requireAuthWithRole:
    (_roles: string[], handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "admin@example.com" } }),
  requirePermission:
    (_permission: string, handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "admin@example.com" } }),
}));

const HEADER = "--\n-- PostgreSQL database dump\n--\n";
const FOOTER = "--\n-- PostgreSQL database dump complete\n--\n";

function makeReq(body: string): NextApiRequest {
  const stream = Readable.from([Buffer.from(body)]);
  return Object.assign(stream, { method: "POST", headers: {}, query: {} }) as never;
}

function makeRes() {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; payload: unknown };
}

/** Did anything actually issue the destructive statement? */
function schemaWasDropped(): boolean {
  return spawned.some((s) => s.stdinChunks.join("").includes("DROP SCHEMA public CASCADE"));
}

describe("admin database restore guards", () => {
  let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeEach(async () => {
    spawned.length = 0;
    ran.length = 0;
    mockMigrateError = null;
    mockSpools.length = 0;
    jest.resetModules();
    process.env.DATABASE_URL = "postgresql://user:pw@localhost:5432/testdb";
    handler = (await import("@/pages/api/admin/database/restore")).default as never;
  });

  it("refuses an empty upload without dropping the schema", async () => {
    const res = makeRes();
    await handler(makeReq(""), res);
    expect(res.statusCode).toBe(400);
    expect(schemaWasDropped()).toBe(false);
  });

  it("refuses a file that is not a pg_dump without dropping the schema", async () => {
    // The wrong-file case: someone uploads a CSV, or last week's export.
    const res = makeRes();
    await handler(makeReq("id,name\n1,Chair\n"), res);
    expect(res.statusCode).toBe(400);
    expect(String((res.payload as { error: string }).error)).toMatch(
      /does not look like a pg_dump/,
    );
    expect(schemaWasDropped()).toBe(false);
  });

  it("refuses a TRUNCATED dump without dropping the schema", async () => {
    // The dangerous case: a real dump, correct header, cut short mid-download.
    // Restoring it silently yields a partial database.
    const res = makeRes();
    await handler(makeReq(`${HEADER}CREATE TABLE "Order" (id int);\nINSERT INTO "Order"`), res);
    expect(res.statusCode).toBe(400);
    expect(String((res.payload as { error: string }).error)).toMatch(/truncated/i);
    expect(schemaWasDropped()).toBe(false);
  });

  it("records a restore that finished, by who, and not one it refused", async () => {
    const record = jest.requireMock("@/lib/audit").auditLog as jest.Mock;
    record.mockClear();

    const refused = makeRes();
    await handler(makeReq(""), refused);
    expect(refused.statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();

    const res = makeRes();
    await handler(makeReq(`${HEADER}CREATE TABLE "Order" (id int);\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0].slice(0, 2)).toEqual(["DATABASE_RESTORED", "admin@example.com"]);
  });

  it("accepts a complete dump and only then drops the schema", async () => {
    const res = makeRes();
    await handler(makeReq(`${HEADER}CREATE TABLE "Order" (id int);\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    expect(schemaWasDropped()).toBe(true);
  });

  it("spools the upload into its own private temp directory and removes it afterwards", async () => {
    // The dump is a full copy of the database. It used to sit at a guessable
    // $TMPDIR/holt-restore-<ms>-<pid>.sql, mode 0644 (CodeQL #20, #22).
    const res = makeRes();
    await handler(makeReq(`${HEADER}SELECT 1;\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    expect(mockSpools).toHaveLength(1);
    const spoolDir = path.dirname(mockSpools[0].path);
    expect(path.dirname(spoolDir)).toBe(path.resolve(tmpdir()));
    if (process.platform !== "win32") {
      expect(mockSpools[0].dirModeWhileSpooling & 0o777).toBe(0o700);
    }
    expect(existsSync(spoolDir)).toBe(false);
  });

  it("removes the spool even when the upload is refused", async () => {
    const res = makeRes();
    await handler(makeReq("id,name\n1,Chair\n"), res);
    expect(res.statusCode).toBe(400);
    expect(mockSpools).toHaveLength(1);
    expect(existsSync(path.dirname(mockSpools[0].path))).toBe(false);
  });

  it("runs psql with ON_ERROR_STOP so a half-applied dump cannot report success", async () => {
    // Without this flag psql exits 0 after logging ERROR lines, which is how a
    // partial restore used to come back as "restored successfully".
    const res = makeRes();
    await handler(makeReq(`${HEADER}SELECT 1;\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    expect(spawned.length).toBeGreaterThan(0);
    for (const s of spawned) {
      expect(s.args).toContain("ON_ERROR_STOP=1");
    }
  });

  // App processes no longer migrate when they restart (RUN_MIGRATIONS=false), so
  // a backup older than the last upgrade stayed on its old schema under a
  // "restored successfully" message.
  it("brings a restored backup up to date: migrations after the restore, not before", async () => {
    const res = makeRes();
    await handler(makeReq(`${HEADER}SELECT 1;\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    expect(ran).toEqual(["psql", "psql", "node_modules/.bin/prisma migrate deploy"]);
    expect(res.payload).toMatchObject({ success: true, message: "Database restored successfully" });
  });

  it("says what to run on the server when the migrations fail after a restore", async () => {
    mockMigrateError = new Error("P3009 migrate found failed migrations");
    const res = makeRes();
    await handler(makeReq(`${HEADER}SELECT 1;\n${FOOTER}`), res);
    expect(res.statusCode).toBe(200);
    const message = String((res.payload as { message: string }).message);
    expect(message).not.toMatch(/successfully/);
    expect(message).toMatch(/docker compose up -d --force-recreate migrate app/);
  });
});
