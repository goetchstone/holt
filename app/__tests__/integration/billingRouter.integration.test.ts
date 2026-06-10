// /app/__tests__/integration/billingRouter.integration.test.ts
//
// Drives the billing tRPC procedures end-to-end through the real appRouter
// (createCallerFactory) against the test DB: the feature gate (NOT_FOUND when
// `billing` is off), the role gate (FORBIDDEN below MANAGER), and the
// create -> list -> detail -> issue -> recordPayment happy path through the
// router layer — input parsing, error translation, and ctx audit fields
// included. The service internals are proven in invoiceLifecycle; this proves
// the wiring the UI actually calls.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import { invalidateAppSettingsCache } from "@/lib/appSettings";

const createCaller = createCallerFactory(appRouter);

function ctxFor(userId: string, email: string): TrpcContext {
  return {
    userId,
    userEmail: email,
    tokenRole: null,
    impersonate: null,
    headers: new Headers(),
  };
}

async function seedOrg(features: Record<string, boolean>) {
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  await prisma.appSettings.create({
    data: { organizationId: 1, appName: "Test Co", features },
  });
  invalidateAppSettingsCache();
}

async function seedStaff(role: string, idSuffix: string) {
  const user = await prisma.user.create({
    data: { id: `test-user-${idSuffix}`, email: `${idSuffix}@test.holt` },
  });
  await prisma.staffMember.create({
    data: {
      displayName: `Staff ${idSuffix}`,
      email: user.email ?? undefined,
      role: role as never,
      isActive: true,
      userId: user.id,
    },
  });
  return user;
}

async function seedGl() {
  const ar = await prisma.gLAccount.create({
    data: { code: "1-1100", name: "AR", accountType: "ASSET" },
  });
  const revenue = await prisma.gLAccount.create({
    data: { code: "4-4000", name: "Revenue", accountType: "REVENUE" },
  });
  const cash = await prisma.gLAccount.create({
    data: { code: "1-1006", name: "Cash", accountType: "ASSET" },
  });
  await prisma.systemGLMapping.createMany({
    data: [
      { section: "AR_TRANSACTIONS", label: "Accounts Receivable", glAccountId: ar.id },
      { section: "AR_TRANSACTIONS", label: "Invoice Sales", glAccountId: revenue.id },
      { section: "POS_PAYMENTS", label: "Check", glAccountId: cash.id },
    ],
  });
}

describe("billing tRPC router against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
    invalidateAppSettingsCache();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns NOT_FOUND on every procedure while the billing feature is off", async () => {
    await seedOrg({ billing: false });
    const admin = await seedStaff("ADMIN", "gate");
    const caller = createCaller(ctxFor(admin.id, admin.email ?? ""));
    await expect(caller.billing.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.billing.create({
        customerId: 1,
        lines: [{ description: "x", quantity: 1, unitPrice: 1 }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses below-MANAGER roles with FORBIDDEN", async () => {
    await seedOrg({ billing: true });
    // A real privileged staff member must exist so the bootstrap safeguard
    // doesn't waive the role check for the designer.
    await seedStaff("ADMIN", "admin");
    const designer = await seedStaff("DESIGNER", "designer");
    const caller = createCaller(ctxFor(designer.id, designer.email ?? ""));
    await expect(caller.billing.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create -> list -> detail -> issue -> recordPayment through the router", async () => {
    await seedOrg({ billing: true });
    await seedGl();
    const admin = await seedStaff("ADMIN", "happy");
    const customer = await prisma.customer.create({
      data: { firstName: "Router", lastName: "Test" },
    });
    const caller = createCaller(ctxFor(admin.id, admin.email ?? ""));

    const created = await caller.billing.create({
      customerId: customer.id,
      lines: [{ description: "Consulting", quantity: 2, unitPrice: 250 }],
      dueDate: "2026-07-01",
      notes: "Net 21",
    });
    expect(created.id).toBeGreaterThan(0);

    const list = await caller.billing.list({ status: "DRAFT" });
    expect(list).toHaveLength(1);
    expect(list[0].total).toBe(500);

    await caller.billing.issue({ id: created.id });
    const detail = await caller.billing.detail({ id: created.id });
    expect(detail.status).toBe("ISSUED");
    // The router stamped the audit field from ctx.userEmail.
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.createdBy).toBe("happy@test.holt");
    expect(row.dueDate).not.toBeNull();

    const payment = await caller.billing.recordPayment({
      id: created.id,
      amount: 500,
      method: "CHECK",
      reference: "1001",
    });
    expect(payment.openBalance).toBe(0);
    const paid = await caller.billing.detail({ id: created.id });
    expect(paid.status).toBe("PAID");
  });

  it("translates service validation errors to BAD_REQUEST with the real message", async () => {
    await seedOrg({ billing: true });
    const admin = await seedStaff("ADMIN", "badreq");
    const customer = await prisma.customer.create({ data: { firstName: "Err" } });
    const caller = createCaller(ctxFor(admin.id, admin.email ?? ""));
    const created = await caller.billing.create({
      customerId: customer.id,
      lines: [{ description: "x", quantity: 1, unitPrice: 100 }],
    });
    // No GL mappings seeded -> issuance refuses with the instructive message.
    await expect(caller.billing.issue({ id: created.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("AR Transactions"),
    });
  });
});
