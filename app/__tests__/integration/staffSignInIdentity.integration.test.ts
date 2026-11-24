// /app/__tests__/integration/staffSignInIdentity.integration.test.ts
//
// USE-02's third door: changing how a staff member signs in. A sign-in email, a
// member's active status, the login a row is linked to and a password each
// decide who can sign in as that member, so each takes what assigning their
// role takes (lib/auth/roleAssignment.ts, signInChangeRefusal): admins only,
// and a member in the owner tier only by an owner. Until 2026-11-21 the Staff
// routes checked only staff.manage, which General Managers and People
// Operations hold, so a General Manager could put their own address on the
// Owner's row, ask for a password reset and sign in as the Owner.
//
// Deactivation is narrower (owner, 2026-11-21 default): any staff.manage
// holder may switch off an ordinary member, an Administrator needs an admin,
// and the owner tier needs an owner. Turning someone back on is a sign-in
// change and takes the full rule.
//
// Real database, real route handlers, a real session per tier. Every refusal
// asserts that nothing was written: the row is re-read, and no STAFF_CHANGED
// entry exists.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
// The public reset routes are rate-limited per client; these tests are one client.
jest.mock("@/lib/rateLimit", () => ({
  rateLimit: () => (handler: unknown) => handler,
}));
// What the reset email would carry, and to whom, without sending one.
jest.mock("@/lib/email/queue", () => ({ enqueueAndSend: jest.fn() }));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache, resolvePermissionAccess } from "@/lib/auth/permissionResolver";
import { hasNoPrivilegedStaff } from "@/lib/auth/authProviders";
import { LAST_ADMIN_MESSAGE } from "@/lib/auth/adminLockout";
import { consumePasswordReset, requestPasswordReset } from "@/lib/auth/passwordReset";
import { enqueueAndSend } from "@/lib/email/queue";
import staffByIdRoute from "@/pages/api/staff/[id]";
import staffIndexRoute from "@/pages/api/staff/index";
import setPasswordRoute from "@/pages/api/admin/staff/[id]/set-password";
import rolesIndexRoute from "@/pages/api/admin/roles/index";
import roleByIdRoute from "@/pages/api/admin/roles/[id]";
import forgotPasswordRoute from "@/pages/api/auth/forgot-password";
import resetPasswordRoute from "@/pages/api/auth/reset-password";

const sessionMock = getServerSession as jest.Mock;
const sendMock = enqueueAndSend as jest.Mock;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  return {
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
}

function makeReq(over: Partial<NextApiRequest> = {}): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "GET", query: {}, body: {}, cookies: {}, headers: {}, ...over } as any;
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  over: Partial<NextApiRequest>,
): Promise<TestRes> {
  const res = makeRes();
  await route(makeReq(over), res);
  return res;
}

/** A signed-in staff member on a built-in role (enum and Role row agree). */
async function makeStaff(userId: string, roleKey: string, email = `${userId}@example.com`) {
  await prisma.user.create({ data: { id: userId, email } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      email,
      displayName: userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: (role.isSystem ? roleKey : "DESIGNER") as any,
      roleId: role.id,
    },
  });
}

/** A staff row nobody has signed in as yet (userId null). */
async function makeUnlinked(name: string, roleKey: string, email: string | null) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      email,
      displayName: name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: (role.isSystem ? roleKey : "DESIGNER") as any,
      roleId: role.id,
    },
  });
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
  invalidateRoleGrantCache();
}

const patch = (id: number, body: Record<string, unknown>) =>
  call(staffByIdRoute, { method: "PATCH", query: { id: String(id) }, body });
const remove = (id: number) =>
  call(staffByIdRoute, { method: "DELETE", query: { id: String(id) } });
const create = (body: Record<string, unknown>) => call(staffIndexRoute, { method: "POST", body });
const setPassword = (id: number) =>
  call(setPasswordRoute, {
    method: "POST",
    query: { id: String(id) },
    body: { password: "a-long-enough-password" },
  });

/** Everything about a row that decides who can sign in as it. */
async function signInFacts(id: number) {
  return prisma.staffMember.findUniqueOrThrow({
    where: { id },
    select: {
      email: true,
      isActive: true,
      userId: true,
      role: true,
      roleId: true,
      passwordHash: true,
    },
  });
}

/** A refusal: the status, nothing written, nothing audited. */
async function expectRefused(
  res: TestRes,
  status: number,
  message: RegExp,
  id: number,
  before: Awaited<ReturnType<typeof signInFacts>>,
) {
  expect({ status: res.statusCode, error: res.body?.error }).toEqual({
    status,
    error: expect.stringMatching(message),
  });
  expect(await signInFacts(id)).toEqual(before);
  expect(await prisma.auditEntry.count({ where: { event: "STAFF_CHANGED" } })).toBe(0);
}

/** The body the Staff screen's form sends on Save (StaffView.tsx handleSave). */
function formSave(member: {
  displayName: string;
  email: string | null;
  roleId: number | null;
  defaultStore: string | null;
  isDesigner: boolean;
}) {
  return {
    displayName: `${member.displayName} (renamed)`,
    email: (member.email ?? "").trim() || null,
    ...(member.roleId == null ? {} : { roleId: member.roleId }),
    defaultStore: member.defaultStore || null,
    isDesigner: member.isDesigner,
    commissionPlanId: null,
    protectionCommissionPlanId: null,
  };
}

let owner: { id: number };
let admin: { id: number };
let gm: { id: number };
let designer: { id: number };

beforeEach(async () => {
  await resetTestDb();
  sessionMock.mockReset();
  sendMock.mockReset();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  owner = await makeStaff("owner", "SUPER_ADMIN");
  admin = await makeStaff("admin", "ADMIN");
  gm = await makeStaff("gm", "GENERAL_MANAGER");
  await makeStaff("hr", "HR");
  designer = await makeStaff("designer", "DESIGNER");
});

afterEach(() => {
  delete process.env.AUTH_LOCAL_ENABLED;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a sign-in email is changed only by an admin, and the owner tier's only by an owner", () => {
  it.each([
    ["gm", () => owner, /only an admin/i],
    ["hr", () => admin, /only an admin/i],
    ["gm", () => designer, /only an admin/i],
    ["admin", () => owner, /only an owner/i],
  ])("refuses %s changing a member's email, and writes nothing", async (who, target, msg) => {
    signInAs(who);
    const before = await signInFacts(target().id);
    const res = await patch(target().id, { email: "mine@example.test" });
    await expectRefused(res, 403, msg, target().id, before);
  });

  it("lets an admin change an ordinary member's email, stored trimmed", async () => {
    signInAs("admin");
    const res = await patch(designer.id, { email: "  new.designer@example.com " });
    expect(res.statusCode).toBe(200);
    expect((await signInFacts(designer.id)).email).toBe("new.designer@example.com");
  });

  it("lets the Owner change an Administrator's email", async () => {
    signInAs("owner");
    const res = await patch(admin.id, { email: "admin.new@example.com" });
    expect(res.statusCode).toBe(200);
    expect((await signInFacts(admin.id)).email).toBe("admin.new@example.com");
  });

  it("never refuses a Save that resends the email unchanged, even one stored untrimmed", async () => {
    await prisma.staffMember.update({
      where: { id: owner.id },
      data: { email: "  owner@example.com " },
    });
    signInAs("gm");
    for (const id of [designer.id, owner.id]) {
      const row = await prisma.staffMember.findUniqueOrThrow({ where: { id } });
      const before = await signInFacts(id);
      const res = await patch(id, formSave(row));
      expect(res.statusCode).toBe(200);
      expect(await signInFacts(id)).toEqual(before);
    }
  });

  it("refuses an email another member already has in any letter case, after the 403", async () => {
    signInAs("admin");
    const before = await signInFacts(designer.id);
    const taken = await patch(designer.id, { email: "Owner@Example.com" });
    expect(taken.statusCode).toBe(409);
    expect(await signInFacts(designer.id)).toEqual(before);

    // A non-admin learns nothing about which addresses exist: the 403 comes first.
    signInAs("gm");
    const probe = await patch(designer.id, { email: "Owner@Example.com" });
    expect(probe.statusCode).toBe(403);
  });
});

describe("the takeover chain: a General Manager's address on the Owner's row", () => {
  it("never reaches a reset token for the Owner", async () => {
    process.env.AUTH_LOCAL_ENABLED = "1";
    signInAs("gm");
    await patch(owner.id, { email: "mine@example.test" });

    const forgot = await call(forgotPasswordRoute, {
      method: "POST",
      body: { email: "mine@example.test" },
    });
    expect(forgot.statusCode).toBe(200); // always ok, whatever happened

    expect(await prisma.passwordResetToken.count({ where: { staffMemberId: owner.id } })).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await signInFacts(owner.id)).passwordHash).toBeNull();
  });
});

describe("switching someone off, and back on", () => {
  it("lets a staff manager deactivate an ordinary member, by PATCH and by DELETE", async () => {
    signInAs("gm");
    expect((await patch(designer.id, { isActive: false })).statusCode).toBe(200);
    expect((await signInFacts(designer.id)).isActive).toBe(false);

    const clerk = await makeStaff("clerk", "REGISTER");
    signInAs("hr");
    expect((await remove(clerk.id)).statusCode).toBe(200);
    expect((await signInFacts(clerk.id)).isActive).toBe(false);
  });

  it("refuses a staff manager deactivating an Administrator or the Owner", async () => {
    signInAs("hr");
    let before = await signInFacts(admin.id);
    await expectRefused(await remove(admin.id), 403, /only an admin/i, admin.id, before);

    signInAs("gm");
    before = await signInFacts(owner.id);
    await expectRefused(
      await patch(owner.id, { isActive: false }),
      403,
      /only an owner/i,
      owner.id,
      before,
    );
  });

  it("refuses an Administrator deactivating the Owner, and lets them deactivate a peer", async () => {
    signInAs("admin");
    const before = await signInFacts(owner.id);
    await expectRefused(await remove(owner.id), 403, /only an owner/i, owner.id, before);

    const peer = await makeStaff("peer", "ADMIN");
    expect((await patch(peer.id, { isActive: false })).statusCode).toBe(200);
    expect((await signInFacts(peer.id)).isActive).toBe(false);
  });

  it("reactivates only by an admin's hand, whoever the member is", async () => {
    await prisma.staffMember.updateMany({
      where: { id: { in: [designer.id, admin.id] } },
      data: { isActive: false },
    });
    signInAs("gm");
    for (const id of [designer.id, admin.id]) {
      const before = await signInFacts(id);
      await expectRefused(await patch(id, { isActive: true }), 403, /only an admin/i, id, before);
    }
    signInAs("owner");
    expect((await patch(admin.id, { isActive: true })).statusCode).toBe(200);
    signInAs("admin");
    expect((await patch(designer.id, { isActive: true })).statusCode).toBe(200);
  });

  it("voids the member's open reset link when they are deactivated", async () => {
    const issued = await requestPasswordReset("admin@example.com");
    expect(issued).not.toBeNull();
    signInAs("owner");
    expect((await remove(admin.id)).statusCode).toBe(200);
    const token = await prisma.passwordResetToken.findFirstOrThrow({
      where: { staffMemberId: admin.id },
    });
    expect(token.usedAt).not.toBeNull();
    const consumed = await consumePasswordReset(issued!.rawToken, "another-long-password");
    expect(consumed.ok).toBe(false);
  });
});

describe("the bootstrap window cannot be reopened by deactivating the linked admins", () => {
  it("counts only admins who can sign in, so the last linked one stays", async () => {
    await resetTestDb();
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
    // The Owner's row exists but nobody has signed in as it yet.
    await makeUnlinked("Owner", "SUPER_ADMIN", "owner@example.com");
    const onlyAdmin = await makeStaff("admin", "ADMIN");
    const manager = await makeStaff("manager", "MANAGER");
    await prisma.user.create({ data: { id: "stranger", email: "stranger@example.net" } });

    signInAs("admin");
    expect((await remove(manager.id)).statusCode).toBe(200);
    const self = await remove(onlyAdmin.id);
    expect(self.statusCode).toBe(409);
    expect(self.body.error).toBe(LAST_ADMIN_MESSAGE);
    expect((await signInFacts(onlyAdmin.id)).isActive).toBe(true);

    invalidateRoleGrantCache();
    const stranger = await resolvePermissionAccess({
      userId: "stranger",
      permission: "admin.data",
      impersonate: null,
    });
    expect(stranger.allowed).toBe(false);
    expect(await hasNoPrivilegedStaff()).toBe(false);
  });
});

describe("two admins switching each other off at once", () => {
  it("leaves one of them: the admin rows are locked, so the second sees the first", async () => {
    await resetTestDb();
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
    const a = await makeStaff("admin-a", "ADMIN");
    const b = await makeStaff("admin-b", "ADMIN");
    // requirePermission reads the session first thing, so the calls take these in order.
    sessionMock
      .mockResolvedValueOnce({ user: { id: "admin-a", email: "admin-a@example.com" } })
      .mockResolvedValueOnce({ user: { id: "admin-b", email: "admin-b@example.com" } });

    const results = await Promise.all([remove(b.id), remove(a.id)]);

    // Whoever locks second finds they were just switched off, so they are no
    // admin any more and are refused; without the lock both read the other as
    // active, both pass, and nobody is left.
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
    expect(
      await prisma.staffMember.count({ where: { id: { in: [a.id, b.id] }, isActive: true } }),
    ).toBe(1);
  });
});

describe("the owner tier's role moves only by an owner's hand", () => {
  it("refuses an Administrator demoting the Owner, and writes nothing", async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    signInAs("admin");
    const before = await signInFacts(owner.id);
    await expectRefused(
      await patch(owner.id, { roleId: adminRole.id }),
      403,
      /only an owner/i,
      owner.id,
      before,
    );
  });

  it("lets the Owner move another owner-tier member", async () => {
    const partner = await makeStaff("partner", "SUPER_ADMIN");
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    signInAs("owner");
    expect((await patch(partner.id, { roleId: adminRole.id })).statusCode).toBe(200);
    expect((await signInFacts(partner.id)).role).toBe("ADMIN");
  });

  it("counts a role holding an owner-only key as the owner tier to assign", async () => {
    signInAs("owner");
    const made = await call(rolesIndexRoute, {
      method: "POST",
      body: { key: "PAYROLL", name: "Payroll", permissions: ["staff.commission-pay"] },
    });
    expect(made.statusCode).toBe(201);
    const payroll = await prisma.role.findUniqueOrThrow({ where: { key: "PAYROLL" } });

    signInAs("admin");
    const before = await signInFacts(designer.id);
    await expectRefused(
      await patch(designer.id, { roleId: payroll.id }),
      403,
      /only an owner/i,
      designer.id,
      before,
    );

    signInAs("owner");
    expect((await patch(designer.id, { roleId: payroll.id })).statusCode).toBe(200);
  });
});

describe("linking a row to a login", () => {
  it("refuses an Administrator pointing an unlinked owner-tier row at an existing login", async () => {
    const partner = await makeUnlinked("Partner", "SUPER_ADMIN", "partner@example.com");
    await prisma.user.create({ data: { id: "orphan", email: "orphan@example.com" } });
    signInAs("admin");
    const before = await signInFacts(partner.id);
    await expectRefused(
      await patch(partner.id, { email: "orphan@example.com" }),
      403,
      /only an owner/i,
      partner.id,
      before,
    );

    signInAs("owner");
    expect((await patch(partner.id, { email: "orphan@example.com" })).statusCode).toBe(200);
    expect((await signInFacts(partner.id)).userId).toBe("orphan");
  });

  it("never links on a staff manager's Save, and still does on an admin's (the rehire repair)", async () => {
    const rehire = await makeUnlinked("Rehire", "DESIGNER", "rehire@example.com");
    await prisma.user.create({ data: { id: "rehire-login", email: "rehire@example.com" } });
    const row = await prisma.staffMember.findUniqueOrThrow({ where: { id: rehire.id } });

    signInAs("gm");
    expect((await patch(rehire.id, formSave(row))).statusCode).toBe(200);
    expect((await signInFacts(rehire.id)).userId).toBeNull();

    signInAs("admin");
    expect((await patch(rehire.id, formSave(row))).statusCode).toBe(200);
    expect((await signInFacts(rehire.id)).userId).toBe("rehire-login");
  });
});

describe("adding a member with a sign-in email", () => {
  it("refuses a staff manager adding one with an email, and allows one without", async () => {
    signInAs("gm");
    const withEmail = await create({ displayName: "Hire", email: "gm.personal@example.net" });
    expect(withEmail.statusCode).toBe(403);
    expect(withEmail.body.error).toMatch(/only an admin/i);
    expect(await prisma.staffMember.count({ where: { displayName: "Hire" } })).toBe(0);

    const without = await create({ displayName: "Hire", email: null });
    expect(without.statusCode).toBe(201);
    expect(without.body.role).toBe("DESIGNER");
  });

  it("lets an admin add one, and refuses an address someone has in another letter case", async () => {
    signInAs("admin");
    const ok = await create({ displayName: "Hire", email: " hire@example.com " });
    expect(ok.statusCode).toBe(201);
    expect(ok.body.email).toBe("hire@example.com");

    const decoy = await create({ displayName: "Decoy", email: "OWNER@example.com" });
    expect(decoy.statusCode).toBe(409);
    expect(
      await prisma.staffMember.count({
        where: { email: { equals: "owner@example.com", mode: "insensitive" } },
      }),
    ).toBe(1);

    signInAs("gm");
    expect((await create({ displayName: "Decoy", email: "OWNER@example.com" })).statusCode).toBe(
      403,
    );
  });
});

describe("set-password reads the member's tier strictly", () => {
  it("keeps a row whose enum says Owner from an Administrator, whatever its Role row says", async () => {
    const designerRole = await prisma.role.findUniqueOrThrow({ where: { key: "DESIGNER" } });
    const split = await prisma.staffMember.create({
      data: {
        displayName: "Split",
        email: "split@example.com",
        role: "SUPER_ADMIN",
        roleId: designerRole.id,
      },
    });
    signInAs("admin");
    const res = await setPassword(split.id);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/only an owner/i);
    expect((await signInFacts(split.id)).passwordHash).toBeNull();
  });

  it("keeps a member whose role holds an owner-only key for the Owner", async () => {
    signInAs("owner");
    await call(rolesIndexRoute, {
      method: "POST",
      body: { key: "PAYROLL", name: "Payroll", permissions: ["staff.commission-pay"] },
    });
    const payroll = await prisma.role.findUniqueOrThrow({ where: { key: "PAYROLL" } });
    const clerk = await makeStaff("clerk", "DESIGNER");
    await prisma.staffMember.update({ where: { id: clerk.id }, data: { roleId: payroll.id } });

    signInAs("admin");
    const byAdmin = await setPassword(clerk.id);
    expect(byAdmin.statusCode).toBe(403);
    expect((await signInFacts(clerk.id)).passwordHash).toBeNull();

    signInAs("owner");
    expect((await setPassword(clerk.id)).statusCode).toBe(200);
  });

  it("answers 409, not 500, when the email's login already belongs to another active member", async () => {
    await prisma.user.create({ data: { id: "shared", email: "shared@example.com" } });
    await prisma.staffMember.create({
      data: { displayName: "Holder", email: "holder@example.com", userId: "shared" },
    });
    const unlinked = await makeUnlinked("Unlinked", "DESIGNER", "shared@example.com");
    signInAs("admin");
    const res = await setPassword(unlinked.id);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already belongs to another active staff member/i);
    expect(await signInFacts(unlinked.id)).toMatchObject({ userId: null, passwordHash: null });
  });

  it("hands an Owner-granted owner-only key on a built-in role to the Owner, except deactivation", async () => {
    const gmRole = await prisma.role.findUniqueOrThrow({
      where: { key: "GENERAL_MANAGER" },
      select: { id: true, permissions: { select: { permission: true } } },
    });
    signInAs("owner");
    const granted = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(gmRole.id) },
      body: {
        permissions: [...gmRole.permissions.map((p) => p.permission), "staff.commission-pay"],
      },
    });
    expect(granted.statusCode).toBe(200);

    signInAs("admin");
    const before = await signInFacts(gm.id);
    await expectRefused(
      await patch(gm.id, { email: "gm.new@example.com" }),
      403,
      /only an owner/i,
      gm.id,
      before,
    );
    expect((await setPassword(gm.id)).statusCode).toBe(403);
    // Switching someone off gives the Administrator nothing, so it stays theirs.
    expect((await remove(gm.id)).statusCode).toBe(200);
  });
});

describe("a reset link dies with the identity it was issued to", () => {
  it("is void once an admin changes the member's email", async () => {
    process.env.AUTH_LOCAL_ENABLED = "1";
    const issued = await requestPasswordReset("designer@example.com");
    expect(issued).not.toBeNull();

    signInAs("admin");
    expect((await patch(designer.id, { email: "designer.new@example.com" })).statusCode).toBe(200);

    const res = await call(resetPasswordRoute, {
      method: "POST",
      body: { token: issued!.rawToken, password: "another-long-password" },
    });
    expect(res.statusCode).toBe(400);
    expect((await signInFacts(designer.id)).passwordHash).toBeNull();
  });

  it("is refused for a member who is no longer active, however they were switched off", async () => {
    const issued = await requestPasswordReset("designer@example.com");
    // Not through the route, so nothing voided the token: the consume checks.
    await prisma.staffMember.update({ where: { id: designer.id }, data: { isActive: false } });
    const consumed = await consumePasswordReset(issued!.rawToken, "another-long-password");
    expect(consumed).toEqual({ ok: false, reason: "This reset link is invalid or has expired" });
    expect((await signInFacts(designer.id)).passwordHash).toBeNull();
  });
});
