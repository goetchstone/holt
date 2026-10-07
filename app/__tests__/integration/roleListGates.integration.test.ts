// /app/__tests__/integration/roleListGates.integration.test.ts
//
// The three legacy role-list gates make one decision (resolveRoleListAccess):
// requireAuthWithRole (Pages API routes), roleProcedure (tRPC) and requirePage
// with a roles array (App Router pages). Until 2026-10-01 the last two read the
// staff row without isActive and turned a missing row into DESIGNER, so a
// deactivated MANAGER kept the MANAGER/ADMIN reports and pages, and a session
// with no staff row passed any list containing DESIGNER (REPORT_ROLES).
//
// Every case runs through all three gates against the real database; only the
// session readers (next-auth, next/headers) and redirect are mocked.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { WITH_COST } from "@/lib/auth/costVisibility";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { requirePage } from "@/lib/auth/requirePage";
import { createCallerFactory, roleProcedure, router } from "@/server/trpc/trpc";
import { appRouter } from "@/server/trpc/routers/_app";
import type { TrpcContext } from "@/server/trpc/context";

const MANAGER_ADMIN = ["SUPER_ADMIN", "ADMIN", "MANAGER"];
// reports.ts REPORT_ROLES: the list a session with no staff row used to pass.
const WITH_DESIGNER = ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"];

type Outcome = { allowed: boolean; role?: string };
type Gate = (userId: string, roles: string[], impersonate: string | null) => Promise<Outcome>;

const pagesApi: Gate = async (userId, roles, impersonate) => {
  (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as NextApiResponse;
  const req = {
    method: "GET",
    cookies: impersonate ? { "holt-impersonate": impersonate } : {},
  } as unknown as NextApiRequest;
  let reached = false;
  await requireAuthWithRole(roles, async () => {
    reached = true;
  })(req, res);
  return { allowed: reached && status === 200 };
};

const trpc: Gate = async (userId, roles, impersonate) => {
  const probe = router({ probe: roleProcedure(roles).query(({ ctx }) => ctx.role) });
  const caller = createCallerFactory(probe)(ctxFor(userId, impersonate));
  try {
    return { allowed: true, role: await caller.probe() };
  } catch (e) {
    if (e instanceof TRPCError && e.code === "FORBIDDEN") return { allowed: false };
    throw e;
  }
};

const page: Gate = async (userId, roles, impersonate) => {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  const jar = impersonate ? [{ name: "holt-impersonate", value: impersonate }] : [];
  (cookies as jest.Mock).mockResolvedValue({
    getAll: () => jar,
    get: (name: string) => jar.find((c) => c.name === name),
  });
  try {
    return { allowed: true, role: (await requirePage(roles)).role };
  } catch (e) {
    if (e instanceof Error && e.message === "REDIRECT /app") return { allowed: false };
    throw e;
  }
};

const GATES: Array<[string, Gate]> = [
  ["requireAuthWithRole", pagesApi],
  ["roleProcedure", trpc],
  ["requirePage", page],
];

function ctxFor(userId: string, impersonate: string | null = null): TrpcContext {
  return {
    userId,
    userEmail: `${userId}@example.com`,
    tokenRole: null,
    impersonate,
    headers: new Headers(),
  };
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

async function makeStaff(userId: string, roleKey: string, isActive = true) {
  await makeUser(userId);
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

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(GATES)("%s", (_name, gate) => {
  describe("with an active admin on staff (no bootstrap)", () => {
    beforeEach(async () => {
      await makeStaff("admin", "ADMIN");
    });

    it("admits an active MANAGER as MANAGER", async () => {
      await makeStaff("mia", "MANAGER");
      const out = await gate("mia", MANAGER_ADMIN, null);
      expect(out.allowed).toBe(true);
      if (out.role !== undefined) expect(out.role).toBe("MANAGER");
    });

    it("refuses a deactivated MANAGER", async () => {
      await makeStaff("gone", "MANAGER", false);
      expect((await gate("gone", MANAGER_ADMIN, null)).allowed).toBe(false);
    });

    it("refuses a session with no staff row, even on a list that names DESIGNER", async () => {
      await makeUser("stranger");
      expect((await gate("stranger", WITH_DESIGNER, null)).allowed).toBe(false);
    });

    it("refuses a deactivated DESIGNER on a list that names DESIGNER", async () => {
      await makeStaff("dee", "DESIGNER", false);
      expect((await gate("dee", WITH_DESIGNER, null)).allowed).toBe(false);
    });

    it("refuses an active DESIGNER on a MANAGER/ADMIN list", async () => {
      await makeStaff("dana", "DESIGNER");
      expect((await gate("dana", MANAGER_ADMIN, null)).allowed).toBe(false);
    });

    it("lets impersonation reduce an ADMIN, never raise anyone", async () => {
      expect((await gate("admin", MANAGER_ADMIN, "DESIGNER")).allowed).toBe(false);
      await makeStaff("dana", "DESIGNER");
      expect((await gate("dana", MANAGER_ADMIN, "ADMIN")).allowed).toBe(false);
    });
  });

  describe("on a new deployment with no active privileged staff (bootstrap)", () => {
    it("still lets the first user in so they can promote themselves", async () => {
      await makeUser("first");
      expect((await gate("first", MANAGER_ADMIN, null)).allowed).toBe(true);
    });

    it("does not count a deactivated admin as privileged", async () => {
      await makeStaff("old-admin", "ADMIN", false);
      await makeUser("first");
      expect((await gate("first", MANAGER_ADMIN, null)).allowed).toBe(true);
    });
  });
});

describe("the real tRPC reports router", () => {
  it("refuses REPORT_ROLES reports to a deactivated designer and to a session with no staff row", async () => {
    await makeStaff("admin", "ADMIN");
    await makeStaff("dee", "DESIGNER", false);
    await makeUser("stranger");
    await makeStaff("dana", "DESIGNER");
    const reports = (userId: string) => createCallerFactory(appRouter)(ctxFor(userId)).reports;

    await expect(reports("dee").departments()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reports("stranger").departments()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reports("dana").departments()).resolves.toEqual([]);
  });
});

describe("roleProcedure answers { also } from the same staff read", () => {
  const holdsAs = (userId: string, impersonate: string | null = null, withCost = true) => {
    const gate = withCost ? roleProcedure(MANAGER_ADMIN, WITH_COST) : roleProcedure(MANAGER_ADMIN);
    const probe = router({ probe: gate.query(({ ctx }) => ctx.holds) });
    return createCallerFactory(probe)(ctxFor(userId, impersonate)).probe();
  };

  /** What the owner does in Roles: untick View cost on a built-in role. */
  async function untickViewCost(roleKey: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: "catalog.cost" },
    });
    await prisma.role.update({ where: { id: role.id }, data: { grantsCustomized: true } });
    invalidateRoleGrantCache();
  }

  it("an unedited MANAGER holds View cost: nothing changes on day one", async () => {
    await makeStaff("mia", "MANAGER");
    await expect(holdsAs("mia")).resolves.toEqual({ "catalog.cost": true });
  });

  it("a MANAGER whose role lost View cost is still admitted, without it", async () => {
    await makeStaff("mia", "MANAGER");
    await untickViewCost("MANAGER");
    await expect(holdsAs("mia")).resolves.toEqual({ "catalog.cost": false });
  });

  it("View as answers for the viewed role, and only ever narrows", async () => {
    await makeStaff("admin", "ADMIN");
    // An unedited ADMIN viewing as an unedited MANAGER sees what MANAGER sees.
    await expect(holdsAs("admin", "MANAGER")).resolves.toEqual({ "catalog.cost": true });
    // ...and as a MANAGER whose role lost the key, sees that too.
    await untickViewCost("MANAGER");
    await expect(holdsAs("admin", "MANAGER")).resolves.toEqual({ "catalog.cost": false });
  });

  it("an ADMIN whose role lost View cost does not get it back by viewing as MANAGER", async () => {
    await makeStaff("admin", "ADMIN");
    await untickViewCost("ADMIN");
    await expect(holdsAs("admin")).resolves.toEqual({ "catalog.cost": false });
    await expect(holdsAs("admin", "MANAGER")).resolves.toEqual({ "catalog.cost": false });
  });

  it("the first user on a new deployment holds it, as they hold every route", async () => {
    await makeUser("first");
    await expect(holdsAs("first")).resolves.toEqual({ "catalog.cost": true });
  });

  it("a DESIGNER is still refused, and a procedure that asks nothing holds nothing", async () => {
    await makeStaff("admin", "ADMIN");
    await makeStaff("dana", "DESIGNER");
    await expect(holdsAs("dana")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(holdsAs("admin", null, false)).resolves.toEqual({});
  });
});
