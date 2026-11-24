// /app/__tests__/impersonateTarget.test.ts
//
// PLACEHOLDER TEST — Grade: B (real route handler, grant table, resolver and
// rank rule; mocked SQL). Prisma answers only the caller's staff row and the
// Role table. Upgrade path: a real-DB case beside the View-as assertions in
// __tests__/integration/roleListGates.integration.test.ts.
//
// POST /api/admin/impersonate refuses a target every gate would ignore.
// resolveEffectiveRole (roleDecision.ts) ignores a View-as cookie naming a role
// ranked above the caller's own, so the gates keep deciding as the caller. The
// client cannot rank: useEffectiveRole shows the "Viewing as" banner and narrows
// the menu from the keys alone. So once a store role holding Change settings
// could View as (2026-11-21), it could set MANAGER, which outranks it, and read
// "Viewing as MANAGER" over screens that still showed its own access. The
// endpoint now refuses that target instead of setting the cookie.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    staffMember: { findFirst: jest.fn() },
    role: { findMany: jest.fn() },
    cacheGeneration: { findMany: jest.fn() },
  },
}));
// The route's own gate is impersonateGate.test.ts's subject; here the handler
// behind it runs as if the gate had let the caller through.
jest.mock("@/lib/auth/requireAuth", () => ({
  requirePermission: jest.fn((_permission: unknown, handler: unknown) => handler),
}));
jest.mock("@/lib/audit", () => ({ auditActor: jest.fn(), auditLog: jest.fn() }));
jest.mock("@/lib/logger", () => ({
  ...jest.requireActual("@/lib/logger"),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import impersonate from "@/pages/api/admin/impersonate";

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => Promise<unknown>;

interface Answer {
  status: number;
  body: { error?: string; impersonating?: string | null };
  cookie: string | undefined;
}

/** A Role row as the grant table reads it. */
function roleRow(id: number, key: string, rank: number, permissions: string[]) {
  return {
    id,
    key,
    rank,
    grantsAllPermissions: false,
    permissions: permissions.map((permission) => ({ permission })),
  };
}

/** The caller's staff row, and the Role table beside it. */
function signedInAs(staff: { role: string; roleId: number | null }, roles: unknown[] = []) {
  (prisma.staffMember.findFirst as jest.Mock).mockResolvedValue(staff);
  (prisma.role.findMany as jest.Mock).mockResolvedValue(roles);
  invalidateRoleGrantCache();
}

async function viewAs(role: string): Promise<Answer> {
  const answer: Answer = { status: 200, body: {}, cookie: undefined };
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(body: Answer["body"]) {
      answer.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      if (name === "Set-Cookie") answer.cookie = value;
      return res;
    },
  };
  const req = { method: "POST", body: { role }, cookies: {}, headers: {} };
  await (impersonate as unknown as Handler)(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    { user: { id: "user-1", email: "user-1@example.com" } } as unknown as Session,
  );
  return answer;
}

beforeEach(() => {
  (prisma.cacheGeneration.findMany as jest.Mock).mockResolvedValue([]);
});

describe("View as refuses a role the gates would ignore", () => {
  it("a store role holding Change settings may not view as MANAGER, which outranks it", async () => {
    // Rank 0, the default for a role a store builds; its staff carry the enum
    // DESIGNER.
    signedInAs({ role: "DESIGNER", roleId: 99 }, [
      roleRow(99, "FLOOR_LEAD", 0, ["admin.settings", "sales.read"]),
    ]);

    const refused = await viewAs("MANAGER");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/MANAGER/);
    expect(refused.cookie).toBeUndefined();

    // A lateral role it may view as, so the cookie is set.
    const allowed = await viewAs("DESIGNER");
    expect(allowed.status).toBe(200);
    expect(allowed.body.impersonating).toBe("DESIGNER");
    expect(allowed.cookie).toMatch(/^holt-impersonate=DESIGNER;/);
  });

  it("the Administrator and the Owner still view as MANAGER", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      // Unlinked and an empty Role table: the built-in definitions and ranks.
      signedInAs({ role, roleId: null });
      const answer = await viewAs("MANAGER");
      expect({ role, status: answer.status, cookie: answer.cookie?.split(";")[0] }).toEqual({
        role,
        status: 200,
        cookie: "holt-impersonate=MANAGER",
      });
    }
  });

  it("a Manager given Change settings views as MANAGER, its own rank", async () => {
    signedInAs({ role: "MANAGER", roleId: 7 }, [
      roleRow(7, "MANAGER", 1, ["admin.settings", "sales.read"]),
    ]);
    expect((await viewAs("MANAGER")).status).toBe(200);
  });

  it("a role holding no View-as key is refused even a lateral role, and told why", async () => {
    // Only the bootstrap safeguard lets such a role past the endpoint's gate;
    // every gate would ignore its cookie, whatever it named.
    signedInAs({ role: "DESIGNER", roleId: 99 }, [roleRow(99, "FLOOR_LEAD", 0, ["sales.read"])]);
    const refused = await viewAs("DESIGNER");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/may not view the app as another role/);
    expect(refused.cookie).toBeUndefined();
  });
});
