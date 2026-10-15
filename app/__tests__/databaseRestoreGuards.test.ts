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

jest.mock("child_process", () => ({
  spawn: jest.fn((_cmd: string, args: string[]) => {
    const record = { args, stdinChunks: [] as string[] };
    spawned.push(record);

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
}));

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
});
