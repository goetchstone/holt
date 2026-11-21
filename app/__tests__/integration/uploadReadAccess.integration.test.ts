// /app/__tests__/integration/uploadReadAccess.integration.test.ts
//
// SEC-04b against Postgres: an uploaded file is read with the key of the screen
// that shows it (UPLOAD_READ_ACCESS in lib/secureUpload.ts), decided by
// resolvePermissionAccess from the staff row -- so a role's grants, a
// deactivation and View as all count, exactly as they do for a gated route.
// Before, any session read every private subdir, and inventory photos and
// ticket files were public.
//
// One ADMIN stays active throughout, or the bootstrap safeguard would admit
// everyone (permissionResolver.ts).
//
// Real route, real gate, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { Writable } from "stream";
import fs from "fs";
import path from "path";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { UPLOAD_READ_ACCESS, UPLOAD_ROOT } from "@/lib/secureUpload";
import handler from "@/pages/api/uploads/[...path]";

const sessionMock = getServerSession as jest.Mock;

const NAME = "test-upload-read-access.png";
const SUBDIRS = Object.keys(UPLOAD_READ_ACCESS).sort();
const PRIVATE = SUBDIRS.filter((s) => !UPLOAD_READ_ACCESS[s].public);
const PUBLIC = SUBDIRS.filter((s) => UPLOAD_READ_ACCESS[s].public);

function makeRes() {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const state = { status: 200, headers: {} as Record<string, unknown> };
  const res = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NextApiResponse;
  res.on("finish", () => resolveDone());
  res.on("close", () => resolveDone());
  Object.assign(res, {
    setHeader(k: string, v: unknown) {
      state.headers[k] = v;
      return res;
    },
    removeHeader(k: string) {
      delete state.headers[k];
    },
    status(c: number) {
      state.status = c;
      return res;
    },
    json() {
      res.end();
      return res;
    },
  });
  return { res, state, done };
}

/** The status a reader gets for this subdir's test file: 200 served, 404 refused. */
async function read(userId: string | null, subdir: string, viewAs?: string): Promise<number> {
  sessionMock.mockResolvedValue(
    userId ? { user: { id: userId, email: `${userId}@example.com` } } : null,
  );
  const { res, state, done } = makeRes();
  await handler(
    {
      method: "GET",
      query: { path: [subdir, NAME] },
      cookies: viewAs ? { "holt-impersonate": viewAs } : {},
    } as unknown as NextApiRequest,
    res,
  );
  await done;
  if (state.status === 200) expect(state.headers["Content-Type"]).toBe("image/png");
  return state.status;
}

async function readable(userId: string | null, viewAs?: string): Promise<string[]> {
  const out: string[] = [];
  for (const subdir of SUBDIRS) {
    if ((await read(userId, subdir, viewAs)) === 200) out.push(subdir);
  }
  return out;
}

async function makeStaff(userId: string, roleKey: string, isActive = true) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      email: `${userId}@example.com`,
      role: roleKey as never,
      roleId: role.id,
      isActive,
    },
  });
}

describe("uploaded files are read with the key of the screen that shows them", () => {
  beforeAll(async () => {
    await resetTestDb();
    invalidateRoleGrantCache();
    await syncBuiltInRoles({ prisma });
    await makeStaff("ada", "ADMIN");
    await makeStaff("wes", "WAREHOUSE");
    await makeStaff("dee", "DESIGNER");
    await makeStaff("cas", "CUSTOMER_SERVICE");
    await makeStaff("max", "MANAGER", false);

    for (const subdir of SUBDIRS) {
      fs.mkdirSync(path.join(UPLOAD_ROOT, subdir), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_ROOT, subdir, NAME), "x");
    }
  });

  afterAll(async () => {
    for (const subdir of SUBDIRS) fs.rmSync(path.join(UPLOAD_ROOT, subdir, NAME), { force: true });
    await prisma.$disconnect();
  });

  it("covers all eight subdirs", () => {
    expect(SUBDIRS).toHaveLength(8);
    expect(PUBLIC).toEqual(["images", "line-drawings"]);
  });

  it("a signed-out visitor reads the public subdirs and nothing else", async () => {
    expect(await readable(null)).toEqual(PUBLIC);
  });

  it("ADMIN reads all eight", async () => {
    expect(await readable("ada")).toEqual(SUBDIRS);
  });

  it("WAREHOUSE reads inventory photos and ticket files, not vendor PDFs", async () => {
    expect(await read("wes", "inventory")).toBe(200);
    expect(await read("wes", "attachments")).toBe(200);
    expect(await read("wes", "pdfs")).toBe(404);
  });

  it("DESIGNER reads ticket files and proposal pictures, not inventory photos or imports", async () => {
    expect(await read("dee", "attachments")).toBe(200);
    expect(await read("dee", "proposals")).toBe(200);
    expect(await read("dee", "inventory")).toBe(404);
    expect(await read("dee", "imports")).toBe(404);
  });

  it("CUSTOMER_SERVICE reads ticket files, not inventory photos", async () => {
    expect(await read("cas", "attachments")).toBe(200);
    expect(await read("cas", "inventory")).toBe(404);
  });

  it("a deactivated MANAGER reads nothing private", async () => {
    expect(await readable("max")).toEqual(PUBLIC);
    for (const subdir of PRIVATE) expect(await read("max", subdir)).toBe(404);
  });

  it("an ADMIN viewing as DESIGNER is refused inventory photos", async () => {
    expect(await read("ada", "inventory", "DESIGNER")).toBe(404);
    expect(await read("ada", "attachments", "DESIGNER")).toBe(200);
  });

  it("a session with no staff row reads nothing private", async () => {
    expect(await readable("nobody-staff")).toEqual(PUBLIC);
  });
});
