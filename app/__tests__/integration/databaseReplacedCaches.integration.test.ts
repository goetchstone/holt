// /app/__tests__/integration/databaseReplacedCaches.integration.test.ts
//
// A database restore, and a practice copy starting over, replace the whole
// database under every running app process. Each process still held cached
// copies -- the grant table, the settings, the import's ids -- from the database
// that was just replaced, and kept using them: the restore route invalidated
// nothing, and start-over only the settings, in its own process.
//
// Both routes now bump every cache generation (lib/cacheGeneration.ts). The
// test stands a second "process" up with jest.isolateModules, lets it cache the
// grant table, changes the roles underneath it WITHOUT a bump (as a restored
// dump does), runs the real route, and checks the second process has let go of
// its copy within the bound. Only what cannot run here is faked: psql, the
// Prisma CLI, and the practice copy's database-file shuffle.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

// psql (restore.ts) reads what it is given and exits 0; `prisma migrate deploy`
// (lib/databaseReplaced.ts, after either route) succeeds. One factory under both names: Jest resolves
// "child_process" and "node:child_process" to the same module, so a second,
// different mock would replace the first.
function mockChildProcess() {
  const { EventEmitter } = jest.requireActual("node:events");
  const { PassThrough } = jest.requireActual("node:stream");
  return {
    ...jest.requireActual("node:child_process"),
    spawn: jest.fn(() => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdin.resume();
      child.stdin.on("finish", () => setImmediate(() => child.emit("close", 0)));
      return child;
    }),
    execFile: jest.fn((_file: string, _args: string[], _opts: unknown, cb: Function) =>
      cb(null, "", ""),
    ),
  };
}
jest.mock("child_process", () => mockChildProcess());
jest.mock("node:child_process", () => mockChildProcess());

jest.mock("@/lib/practiceCopy", () => ({
  ...jest.requireActual("@/lib/practiceCopy"),
  isPracticeCopy: jest.fn(() => false),
}));

jest.mock("@/lib/practiceCopyDatabase", () => ({
  ...jest.requireActual("@/lib/practiceCopyDatabase"),
  restoreStartingPoint: jest.fn(async () => {}),
}));

import { Readable } from "node:stream";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import type * as ResolverModule from "@/lib/auth/permissionResolver";
import { isPracticeCopy } from "@/lib/practiceCopy";
import { CACHE_GENERATION_CHECK_MS, CACHE_GENERATION_KEYS } from "@/lib/cacheGeneration";
import restoreRoute from "@/pages/api/admin/database/restore";
import practiceRoute from "@/pages/api/admin/database/practice";

const sessionMock = getServerSession as jest.Mock;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
  return res;
}

/** A POST whose body streams, as the restore route reads it. */
function uploadReq(body: string): NextApiRequest {
  const stream = Readable.from([Buffer.from(body)]);
  return Object.assign(stream, {
    method: "POST",
    query: {},
    cookies: {},
    headers: {},
  }) as unknown as NextApiRequest;
}

const DUMP =
  "--\n-- PostgreSQL database dump\n--\n\nSELECT 1;\n\n--\n-- PostgreSQL database dump complete\n--\n";

/** The grant table, as a second app process sees it. */
function secondProcessResolver(): typeof ResolverModule {
  let mod!: typeof ResolverModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@/lib/auth/permissionResolver");
  });
  return mod;
}

async function generations(): Promise<Map<string, bigint>> {
  const rows = await prisma.cacheGeneration.findMany();
  return new Map(rows.map((r) => [r.key, r.generation]));
}

let floorRoleId: number;

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  floorRoleId = (
    await prisma.role.create({
      data: {
        key: "FLOOR",
        name: "Floor",
        isSystem: false,
        grantsAllPermissions: false,
        permissions: { create: [{ permission: "payment.refund" }] },
      },
    })
  ).id;
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const owner = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "owner", displayName: "Owner", role: "SUPER_ADMIN", roleId: owner.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Process B caches FLOOR's grants, the roles change underneath it with no bump
 * (what a restored dump does), `replace` runs, and B must see the new grants
 * once the bound has passed. Returns the generations before and after.
 */
async function expectSecondProcessReloads(replace: () => Promise<TestRes>) {
  const b = secondProcessResolver();
  const floorGrants = async () => (await b.getRoleGrantTable()).grantsByRole.FLOOR ?? [];
  expect(await floorGrants()).toContain("payment.refund");

  await prisma.rolePermission.deleteMany({ where: { roleId: floorRoleId } });
  const before = await generations();

  const res = await replace();
  expect(res.statusCode).toBe(200);

  await sleep(CACHE_GENERATION_CHECK_MS + 300);
  expect(await floorGrants()).not.toContain("payment.refund");

  const after = await generations();
  for (const key of CACHE_GENERATION_KEYS) {
    expect({ key, bumped: after.get(key)! > (before.get(key) ?? BigInt(0)) }).toEqual({
      key,
      bumped: true,
    });
  }
  return res;
}

/** The Prisma CLI commands run so far, as "migrate deploy". */
function prismaCommandsRun(): string[] {
  const execFile = jest.requireMock("node:child_process").execFile as jest.Mock;
  return execFile.mock.calls
    .filter(([file]) => String(file).endsWith("prisma"))
    .map(([, args]) => (args as string[]).join(" "));
}

beforeEach(() => {
  (jest.requireMock("node:child_process").execFile as jest.Mock).mockClear();
});

it("a restore from a backup makes every process drop what it cached", async () => {
  const res = await expectSecondProcessReloads(async () => {
    const out = makeRes();
    await restoreRoute(uploadReq(DUMP), out);
    return out;
  });
  expect(res.body).toMatchObject({ success: true, message: "Database restored successfully" });
  // A backup older than the last upgrade is migrated, since restarting an app
  // process no longer does that (RUN_MIGRATIONS=false).
  expect(prismaCommandsRun()).toEqual(["migrate deploy"]);
});

it("a practice copy starting over makes every process drop what it cached", async () => {
  (isPracticeCopy as jest.Mock).mockReturnValue(true);
  try {
    await expectSecondProcessReloads(async () => {
      const out = makeRes();
      await practiceRoute(
        {
          method: "POST",
          query: {},
          cookies: {},
          headers: {},
          body: { action: "start-over" },
        } as unknown as NextApiRequest,
        out,
      );
      return out;
    });
  } finally {
    (isPracticeCopy as jest.Mock).mockReturnValue(false);
  }
});
