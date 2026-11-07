// __tests__/integration/auditTrail.integration.test.ts
//
// GAP-29: the app can answer "who did this". Real routes, real database; only the
// session readers are mocked, so each test signs in as a real staff member and does
// the thing through the route a screen calls.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { hashPassword } from "@/lib/auth/password";
import { auditLog } from "@/lib/audit";
import { AUDIT_PAGE_SIZE, auditFilterFrom, loadAuditFeed, type AuditFilter } from "@/lib/auditFeed";
import { postBackdatedMovement } from "@/lib/inventory/ledger";
import { placeAt } from "@/lib/inventory/places";
import { createCallerFactory } from "@/server/trpc/trpc";
import { appRouter } from "@/server/trpc/routers/_app";
import orderRoute from "@/pages/api/sales/orders/[id]";
import refundsRoute from "@/pages/api/sales/orders/[id]/refunds";
import voidRoute from "@/pages/api/sales/orders/[id]/payments/[paymentId]/void";
import deleteCustomersRoute from "@/pages/api/customers/delete-all";
import deleteCategoriesRoute from "@/pages/api/categories/delete-all";
import deleteCampaignsRoute from "@/pages/api/mailchimp/delete-all";
import mergeCustomersRoute from "@/pages/api/customers/merge-duplicates";
import clearAllRoute from "@/pages/api/inventory/clear-all-data";
import clearLocationRoute from "@/pages/api/inventory/clear-location";
import rolesRoute from "@/pages/api/admin/roles/index";
import roleRoute from "@/pages/api/admin/roles/[id]";
import staffRoute from "@/pages/api/staff/index";
import staffMemberRoute from "@/pages/api/staff/[id]";
import setPasswordRoute from "@/pages/api/admin/staff/[id]/set-password";
import impersonateRoute from "@/pages/api/admin/impersonate";
import settingsRoute from "@/pages/api/admin/settings/index";
import integrationsRoute from "@/pages/api/admin/settings/integrations";
import automationRoute from "@/pages/api/admin/automations/[key]";
import emailLookRoute from "@/pages/api/admin/email-look/[kind]";
import tendersRoute from "@/pages/api/tenders/index";
import tenderRoute from "@/pages/api/tenders/[id]";
import taxDistrictsRoute from "@/pages/api/tax/districts/index";
import taxDistrictRoute from "@/pages/api/tax/districts/[id]";
import taxGroupsRoute from "@/pages/api/tax/groups/index";
import taxGroupRoute from "@/pages/api/tax/groups/[id]";
import productRoute from "@/pages/api/products/[id]";
import reconcileRoute from "@/pages/api/inventory/reconcile";
import undoReconcileRoute from "@/pages/api/inventory/undo-reconciliation";
import physicalCountRoute from "@/pages/api/inventory/physical-count/[id]";
import consignmentResetRoute from "@/pages/api/consignment/bulk-reset-missing";
import tiersRoute from "@/pages/api/admin/reports/commission-tiers/tiers";
import taxRulesRoute from "@/pages/api/tax/rules/index";
import taxRuleRoute from "@/pages/api/tax/rules/[id]";
import exemptReasonsRoute from "@/pages/api/tax/exempt-reasons/index";
import exemptReasonRoute from "@/pages/api/tax/exempt-reasons/[id]";
import sourceRoute from "@/pages/api/products/[id]/sources/[sourceId]";
import styleRoute from "@/pages/api/pricing/styles/[id]/index";
import vendorMergeRoute from "@/pages/api/vendors/[id]/merge";
import journalRoute from "@/pages/api/accounting/journal-entries/[id]";
import exportRoute from "@/pages/api/admin/export/[entity]";
import windfallCustomersRoute from "@/pages/api/exports/windfall-customers";
import emailListRoute from "@/pages/api/customers/email-list";
import AuditTrailPage from "@/app/(dashboard)/app/admin/audit/page";

const STORE = { timezone: "America/New_York", locale: "en-US", currency: "USD" };

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(
  route: Route,
  who: string,
  {
    method = "POST",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: object } = {},
) {
  const session = { user: { id: who, email: `${who}@example.com` } };
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    send(value: unknown) {
      payload = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status, body: payload as Record<string, any> };
}

async function makeStaff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
}

async function onlyEntry(event: string) {
  const entries = await prisma.auditEntry.findMany({ where: { event } });
  expect(entries).toHaveLength(1);
  return entries[0];
}

async function makeOrder(status: "ORDER" | "QUOTE" = "ORDER") {
  const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
  return prisma.salesOrder.create({
    data: { orderno: `SO-${customer.id}`, status, customerId: customer.id },
  });
}

async function makeProduct(productNumber = "S-1", baseRetail?: number) {
  const vendor = await prisma.vendor.create({ data: { name: `Vendor ${productNumber}` } });
  const department = await prisma.department.create({ data: { name: `Dept ${productNumber}` } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  return prisma.product.create({
    data: {
      productNumber,
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail,
    },
  });
}

/** Stock moved into a store through the ledger, as production does it. */
async function moveStock(productId: number, actor: string | null, when = new Date()) {
  const store = await prisma.storeLocation.upsert({
    where: { code: "MS" },
    update: {},
    create: { name: "Main Street", code: "MS", type: "STORE" },
  });
  const to = await placeAt(prisma, { storeLocationId: store.id });
  await postBackdatedMovement(
    prisma,
    { productId, quantity: 3, to, reason: "OPENING", actor },
    when,
  );
}

async function makePayment(salesOrderId: number, status: string, paymentAmount = 100) {
  return prisma.payment.create({
    data: {
      salesOrderId,
      paymentDate: new Date(),
      paymentType: "CASH",
      paymentAmount,
      status: status as never,
    },
  });
}

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, appName: "Holt", supportEmail: "a@example.com" },
  });
  invalidateAppSettingsCache();
  await makeStaff("owner", "SUPER_ADMIN");
  await makeStaff("boss", "ADMIN");
  await makeStaff("till", "REGISTER");
});

describe("recording an entry", () => {
  it("keeps who, what and the target, and links back to it", async () => {
    await auditLog("PRODUCT_PRICE_CHANGED", "pat@example.com", {
      summary: "Sofa: retail 100 → 90",
      target: { type: "product", id: 7 },
      details: { from: 100 },
    });
    const entry = await onlyEntry("PRODUCT_PRICE_CHANGED");
    expect(entry).toMatchObject({
      actor: "pat@example.com",
      summary: "Sofa: retail 100 → 90",
      targetType: "product",
      targetId: "7",
      details: { from: 100 },
    });
  });

  it("stands or falls with the action inside a transaction", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await auditLog("QUOTE_DELETED", "pat", { summary: "gone" }, tx);
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("makes the action fail with it inside a transaction, so nothing goes unrecorded", async () => {
    const order = await makeOrder();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.salesOrder.update({
          where: { id: order.id },
          data: { status: "FULFILLED" },
        });
        await auditLog("QUOTE_DELETED", "pat", { summary: "x" }, {
          auditEntry: { create: () => Promise.reject(new Error("no room")) },
        } as never);
      }),
    ).rejects.toThrow("no room");
    const after = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("ORDER");
  });

  it("doesn't fail an action that has already happened when the write fails", async () => {
    const spy = jest
      .spyOn(prisma.auditEntry, "create")
      .mockRejectedValueOnce(new Error("no room") as never);
    await expect(auditLog("DATA_EXPORTED", "pat", { summary: "x" })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("orders and payments", () => {
  it("records a deleted quote, and the entry outlives it and its history", async () => {
    const order = await makeOrder("QUOTE");
    await prisma.orderChangeLog.create({
      data: { salesOrderId: order.id, changeType: "LINE_NOTE", changedBy: "someone" },
    });

    const res = await call(orderRoute, "boss", {
      method: "DELETE",
      query: { id: String(order.id) },
    });

    expect(res.status).toBe(204);
    expect(await prisma.salesOrder.count({ where: { id: order.id } })).toBe(0);
    expect(await prisma.orderChangeLog.count()).toBe(0);
    const entry = await onlyEntry("QUOTE_DELETED");
    expect(entry.actor).toBe("boss@example.com");
    expect(entry.summary).toBe(`Quote ${order.orderno} deleted`);
    // Nothing to open: linking to it would be a dead link.
    expect(entry.targetType).toBeNull();
  });

  it("records nothing when the delete is refused", async () => {
    const order = await makeOrder("QUOTE");
    const res = await call(orderRoute, "till", {
      method: "DELETE",
      query: { id: String(order.id) },
    });
    expect(res.status).toBe(403);
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("puts a refund in the order's own history, with who and why", async () => {
    const order = await makeOrder();
    const payment = await makePayment(order.id, "COMPLETED", 100);
    const res = await call(refundsRoute, "boss", {
      query: { id: String(order.id) },
      body: { paymentId: String(payment.id), amount: "40", reason: "scratched" },
    });
    expect(res.status).toBe(201);
    const change = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "REFUND_ISSUED" },
    });
    expect(change).toMatchObject({
      newValue: "40",
      reason: "scratched",
      changedBy: "boss@example.com",
    });
  });

  it("puts a voided payment in the order's own history", async () => {
    const order = await makeOrder();
    const payment = await makePayment(order.id, "PENDING", 75);
    const res = await call(voidRoute, "boss", {
      query: { id: String(order.id), paymentId: String(payment.id) },
      body: { reason: "stuck" },
    });
    expect(res.status).toBe(200);
    const change = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "PAYMENT_VOIDED" },
    });
    expect(change).toMatchObject({ reason: "stuck", changedBy: "boss@example.com" });
    expect(Number(change.previousValue)).toBe(75);
  });
});

describe("deleting and clearing", () => {
  it("records deleting every customer, with how many", async () => {
    await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
    await prisma.customer.create({ data: { firstName: "Bo", lastName: "Reyes" } });
    await call(deleteCustomersRoute, "owner", { method: "DELETE" });
    const entry = await onlyEntry("BULK_DELETED");
    expect(entry).toMatchObject({
      actor: "owner@example.com",
      summary: "All 2 customers deleted",
    });
  });

  it("records deleting every category", async () => {
    await call(deleteCategoriesRoute, "owner", { method: "DELETE" });
    expect((await onlyEntry("BULK_DELETED")).summary).toBe("All 0 categories deleted");
  });

  it("records deleting every email campaign", async () => {
    await call(deleteCampaignsRoute, "owner", { method: "DELETE" });
    expect((await onlyEntry("BULK_DELETED")).summary).toContain("email campaigns deleted");
  });

  it("records merging duplicate customers", async () => {
    await call(mergeCustomersRoute, "owner");
    expect((await onlyEntry("CUSTOMERS_MERGED")).actor).toBe("owner@example.com");
  });

  it("records clearing every count, and one location's", async () => {
    await call(clearAllRoute, "owner");
    await call(clearLocationRoute, "owner", { body: { location: "Main Street" } });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "STOCK_CLEARED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      "All physical counts cleared: 0 scans, 0 reconciliations",
      "Physical counts cleared at Main Street: 0 scans, 0 reconciliations",
    ]);
  });
});

describe("people and access", () => {
  it("records a role made, changed and deleted, naming the permissions", async () => {
    const made = await call(rolesRoute, "owner", {
      body: { key: "FLOOR_LEAD", name: "Floor Lead", rank: 0, permissions: ["customer.read"] },
    });
    expect(made.status).toBe(201);
    const roleId = String(made.body.role.id);

    await call(roleRoute, "owner", {
      method: "PUT",
      query: { id: roleId },
      body: { permissions: ["sales.write"] },
    });
    await call(roleRoute, "owner", { method: "DELETE", query: { id: roleId } });

    const entries = await prisma.auditEntry.findMany({
      where: { event: "ROLE_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      'Role "Floor Lead" created with 1 permissions',
      'Role "Floor Lead": 1 permissions added, 1 taken away',
      'Role "Floor Lead" deleted, 0 staff moved to another role',
    ]);
    expect(entries[1].details).toEqual({ added: ["sales.write"], removed: ["customer.read"] });
  });

  it("records nothing when a role is saved with no change to what it can do", async () => {
    const role = await prisma.role.create({
      data: { key: "QUIET", name: "Quiet", rank: 0, isSystem: false },
    });
    await call(roleRoute, "owner", {
      method: "PUT",
      query: { id: String(role.id) },
      body: { permissions: [] },
    });
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("records a staff member added", async () => {
    const res = await call(staffRoute, "owner", {
      body: { displayName: "Sam", email: "sam@example.com", role: "REGISTER" },
    });
    expect(res.status).toBe(201);
    expect((await onlyEntry("STAFF_CHANGED")).summary).toBe("Sam added as REGISTER");
  });

  it("records a role change, a login change and a deactivation", async () => {
    const till = await prisma.staffMember.findFirstOrThrow({ where: { userId: "till" } });
    const query = { id: String(till.id) };
    const admin = await prisma.role.findUniqueOrThrow({ where: { key: "MANAGER" } });

    await call(staffMemberRoute, "owner", {
      method: "PATCH",
      query,
      body: { roleId: admin.id },
    });
    await call(staffMemberRoute, "owner", {
      method: "PATCH",
      query,
      body: { email: "new@example.com" },
    });
    await call(staffMemberRoute, "owner", { method: "DELETE", query });

    const entries = await prisma.auditEntry.findMany({
      where: { event: "STAFF_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      "till: role REGISTER → MANAGER",
      "till: login email changed",
      "till: deactivated",
    ]);
  });

  it("records someone being switched off and back on", async () => {
    const till = await prisma.staffMember.findFirstOrThrow({ where: { userId: "till" } });
    const query = { id: String(till.id) };
    await call(staffMemberRoute, "owner", { method: "PATCH", query, body: { isActive: false } });
    await call(staffMemberRoute, "owner", { method: "PATCH", query, body: { isActive: true } });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "STAFF_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual(["till: deactivated", "till: reactivated"]);
  });

  it("records nothing for a change that doesn't touch access", async () => {
    const till = await prisma.staffMember.findFirstOrThrow({ where: { userId: "till" } });
    await call(staffMemberRoute, "owner", {
      method: "PATCH",
      query: { id: String(till.id) },
      body: { displayName: "Till Two" },
    });
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  it("records a password set by an admin, and never the password", async () => {
    const till = await prisma.staffMember.findFirstOrThrow({ where: { userId: "till" } });
    const secret = "a-long-enough-password";
    const res = await call(setPasswordRoute, "owner", {
      query: { id: String(till.id) },
      body: { password: secret },
    });
    expect(res.status).toBe(200);
    const entry = await onlyEntry("PASSWORD_SET");
    expect(entry.summary).toBe("Password set for till");
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("records someone changing their own PIN, and never the PIN", async () => {
    const secret = "correct-horse-battery";
    await prisma.staffMember.updateMany({
      where: { userId: "boss" },
      data: { passwordHash: hashPassword(secret) },
    });
    const caller = createCallerFactory(appRouter)({ userId: "boss" } as never);
    await caller.account.setPin({ currentPassword: secret, pin: "482913" });
    const entry = await onlyEntry("PIN_CHANGED");
    expect(entry.actor).toBe("boss@example.com");
    expect(JSON.stringify(entry)).not.toContain("482913");
  });

  it("records viewing the app as another role, and stopping", async () => {
    await call(impersonateRoute, "owner", { body: { role: "REGISTER" } });
    await call(impersonateRoute, "owner", { body: { role: null } });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "IMPERSONATION" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      "Started viewing the app as REGISTER",
      "Stopped viewing the app as another role",
    ]);
  });
});

describe("settings", () => {
  it("names the settings that changed, and only those", async () => {
    const res = await call(settingsRoute, "owner", {
      method: "PUT",
      body: { appName: "Holt", supportEmail: "b@example.com" },
    });
    expect(res.status).toBe(200);
    const entry = await onlyEntry("SETTINGS_SAVED");
    expect(entry.summary).toBe("Changed: supportEmail");
    expect(JSON.stringify(entry)).not.toContain("b@example.com");
  });

  it("records nothing when saving changes nothing", async () => {
    await call(settingsRoute, "owner", { method: "PUT", body: { appName: "Holt" } });
    expect(await prisma.auditEntry.count()).toBe(0);
  });

  describe("integration keys", () => {
    const savedKey = process.env.APP_ENCRYPTION_KEY;
    beforeEach(() => {
      process.env.APP_ENCRYPTION_KEY = "0".repeat(64);
    });
    afterEach(() => {
      process.env.APP_ENCRYPTION_KEY = savedKey;
    });

    it("records a key saved and removed by name, and never its value", async () => {
      const secret = "sk_test_never_show_this";
      const saved = await call(integrationsRoute, "owner", {
        method: "PUT",
        body: { provider: "stripe", field: "secretKey", value: secret },
      });
      expect(saved.status).toBe(200);
      await call(integrationsRoute, "owner", {
        method: "DELETE",
        body: { provider: "stripe", field: "secretKey" },
      });
      const entries = await prisma.auditEntry.findMany({
        where: { event: "CREDENTIAL_CHANGED" },
        orderBy: { id: "asc" },
      });
      expect(entries.map((e) => e.summary)).toEqual([
        "stripe secretKey saved",
        "stripe secretKey removed",
      ]);
      expect(JSON.stringify(entries)).not.toContain(secret);
    });
  });

  it("records an email's wording saved, and put back, but not a preview", async () => {
    const query = { kind: "follow-up" };
    const preview = await call(emailLookRoute, "owner", { query, body: {} });
    expect(preview.status).toBe(200);
    expect(await prisma.auditEntry.count()).toBe(0);

    const saved = await call(emailLookRoute, "owner", {
      method: "PUT",
      query,
      body: { subject: "Today's follow-ups" },
    });
    expect(saved.status).toBe(200);
    await call(emailLookRoute, "owner", { method: "DELETE", query });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "EMAIL_WORDING_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      "follow-up: wording saved",
      "follow-up: back to the suggested wording",
    ]);
  });

  it("records an automation changed", async () => {
    const res = await call(automationRoute, "owner", {
      method: "PUT",
      query: { key: "ar-drift" },
      body: { isActive: false, frequency: "DAILY", hour: 4 },
    });
    expect(res.status).toBe(200);
    expect((await onlyEntry("AUTOMATION_CHANGED")).summary).toBe("ar-drift: off, DAILY");
  });

  it("records a payment type added, changed and deleted", async () => {
    const made = await call(tendersRoute, "owner", {
      body: { name: "House Account", kind: "OTHER" },
    });
    expect(made.status).toBe(201);
    const query = { id: String(made.body.id) };
    const changed = await call(tenderRoute, "owner", {
      method: "PUT",
      query,
      body: { sortOrder: 5 },
    });
    expect(changed.status).toBe(200);
    const gone = await call(tenderRoute, "owner", { method: "DELETE", query });
    expect(gone.status).toBe(200);
    const entries = await prisma.auditEntry.findMany({ where: { event: "TENDER_CHANGED" } });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.actor === "owner@example.com")).toBe(true);
  });

  it("records tax districts and groups added, changed and deleted", async () => {
    const district = await call(taxDistrictsRoute, "owner", {
      body: { shortName: "ST", state: "CT", name: "State Tax" },
    });
    const dq = { id: String(district.body.id) };
    await call(taxDistrictRoute, "owner", {
      method: "PUT",
      query: dq,
      body: { shortName: "ST", state: "CT", name: "State" },
    });
    await call(taxDistrictRoute, "owner", { method: "DELETE", query: dq });

    const group = await call(taxGroupsRoute, "owner", { body: { name: "Furniture" } });
    const gq = { id: String(group.body.id) };
    await call(taxGroupRoute, "owner", { method: "PUT", query: gq, body: { name: "Goods" } });
    await call(taxGroupRoute, "owner", { method: "DELETE", query: gq });

    expect(await prisma.auditEntry.count({ where: { event: "TAX_CHANGED" } })).toBe(6);
  });
});

describe("prices", () => {
  it("records a retail price moving, from what to what", async () => {
    const product = await makeProduct("S-1", 100);
    const res = await call(productRoute, "owner", {
      method: "PATCH",
      query: { id: String(product.id) },
      body: { baseRetail: "90" },
    });
    expect(res.status).toBe(200);
    expect(await onlyEntry("PRODUCT_PRICE_CHANGED")).toMatchObject({
      summary: "Sofa: retail 100 → 90",
      targetType: "product",
      targetId: String(product.id),
    });
  });

  it("records nothing when the price stays put", async () => {
    const product = await makeProduct("S-1", 100);
    await call(productRoute, "owner", {
      method: "PATCH",
      query: { id: String(product.id) },
      body: { name: "Sofa Two", baseRetail: "100" },
    });
    expect(await prisma.auditEntry.count()).toBe(0);
  });
});

describe("taking data out", () => {
  it("records an export, by name", async () => {
    const res = await call(exportRoute, "owner", {
      method: "GET",
      query: { entity: "customers" },
    });
    expect(res.status).toBe(200);
    expect((await onlyEntry("DATA_EXPORTED")).summary).toMatch(/^customers-.*\.csv exported$/);
  });

  it("records the customer list going out", async () => {
    const res = await call(windfallCustomersRoute, "owner", { method: "GET" });
    expect(res.status).toBe(200);
    expect((await onlyEntry("DATA_EXPORTED")).summary).toContain("customer list");
  });

  it("records the email list being downloaded, but not previewed", async () => {
    const preview = await call(emailListRoute, "owner", { method: "GET" });
    expect(preview.status).toBe(200);
    expect(await prisma.auditEntry.count()).toBe(0);

    await call(emailListRoute, "owner", { method: "GET", query: { format: "csv" } });
    expect((await onlyEntry("DATA_EXPORTED")).summary).toContain("Customer email list exported");
  });
});

describe("stock counts", () => {
  it("records a reconciliation and undoing it", async () => {
    const product = await makeProduct("R-1");
    const made = await call(reconcileRoute, "owner", {
      body: {
        item: {
          productId: product.id,
          location: "Main Street",
          expected: 5,
          counted: 4,
          variance: -1,
        },
        action: "found",
      },
    });
    expect(made.status).toBe(200);
    expect(await onlyEntry("STOCK_RECONCILED")).toMatchObject({
      targetType: "product",
      targetId: String(product.id),
    });

    const undone = await call(undoReconcileRoute, "owner", {
      body: { reconciliationId: made.body.reconciliation.id },
    });
    expect(undone.status).toBe(200);
    expect((await onlyEntry("RECONCILIATION_UNDONE")).summary).toContain("Main Street");
  });

  it("records a scan being deleted", async () => {
    const product = await makeProduct("C-1");
    const scan = await prisma.physicalInventoryCount.create({
      data: { productId: product.id, stockLocation: "Floor", quantity: 1 },
    });
    const res = await call(physicalCountRoute, "owner", {
      method: "DELETE",
      query: { id: String(scan.id) },
    });
    expect(res.status).toBe(204);
    expect((await onlyEntry("PHYSICAL_COUNT_DELETED")).summary).toBe("A scan at Floor deleted");
  });

  it("records missing consignment being reset", async () => {
    await call(consignmentResetRoute, "owner");
    expect((await onlyEntry("CONSIGNMENT_RESET")).actor).toBe("owner@example.com");
  });
});

describe("commission", () => {
  it("records a plan added, its tiers replaced, made the default and deleted", async () => {
    const tiers = [{ label: "All", minYtdSales: 0, maxYtdSalesExclusive: null, rate: 0.05 }];
    const made = await call(tiersRoute, "owner", { body: { name: "Summer", tiers } });
    expect(made.status).toBe(201);
    const planId = made.body.id;
    await call(tiersRoute, "owner", {
      method: "PUT",
      body: { planId, tiers },
    });
    const other = await call(tiersRoute, "owner", { body: { name: "Other", tiers } });
    await call(tiersRoute, "owner", { method: "PATCH", body: { planId, action: "setDefault" } });
    await call(tiersRoute, "owner", { method: "DELETE", body: { planId: other.body.id } });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "COMMISSION_PLAN_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      `Commission plan ${planId} added`,
      `Commission plan ${planId}: tiers replaced`,
      `Commission plan ${other.body.id} added`,
      `Commission plan ${planId} made the default`,
      `Commission plan ${other.body.id} deleted`,
    ]);
  });
});

describe("the books", () => {
  async function makeJournal() {
    const account = await prisma.gLAccount.create({
      data: { code: "1-1100", name: "AR", accountType: "ASSET" },
    });
    const lines = [
      { glAccountId: account.id, memo: "Cash", debit: 10, credit: 0 },
      { glAccountId: account.id, memo: "Sales", debit: 0, credit: 10 },
    ];
    return prisma.journalEntry.create({
      data: {
        journalNumber: "JE-1",
        journalDate: new Date(),
        totalDebits: 10,
        totalCredits: 10,
        lines: { create: lines },
      },
    });
  }

  it("records a journal entry posted, and nothing for a touch", async () => {
    const entry = await makeJournal();
    const query = { id: String(entry.id) };
    await call(journalRoute, "boss", { method: "PUT", query, body: {} });
    expect(await prisma.auditEntry.count()).toBe(0);
    const res = await call(journalRoute, "boss", {
      method: "PUT",
      query,
      body: { status: "POSTED" },
    });
    expect(res.status).toBe(200);
    expect((await onlyEntry("JOURNAL_POSTED")).summary).toBe(`Journal entry ${entry.id} posted`);
  });
});

describe("more of the setup", () => {
  it("records a tax rule added, changed and deleted", async () => {
    const district = await call(taxDistrictsRoute, "owner", {
      body: { shortName: "ST", state: "CT", name: "State Tax" },
    });
    const group = await call(taxGroupsRoute, "owner", { body: { name: "Furniture" } });
    const made = await call(taxRulesRoute, "owner", {
      body: { districtId: district.body.id, groupId: group.body.id, taxRate: 6.35 },
    });
    expect(made.status).toBe(201);
    const query = { id: String(made.body.id) };
    const changed = await call(taxRuleRoute, "owner", {
      method: "PUT",
      query,
      body: { districtId: district.body.id, groupId: group.body.id, taxRate: 7 },
    });
    expect(changed.status).toBe(200);
    await call(taxRuleRoute, "owner", { method: "DELETE", query });
    const summaries = (await prisma.auditEntry.findMany({ where: { event: "TAX_CHANGED" } })).map(
      (e) => e.summary,
    );
    expect(summaries).toEqual(
      expect.arrayContaining([
        `Tax rule ${made.body.id} added`,
        `Tax rule ${made.body.id} changed`,
        `Tax rule ${made.body.id} deleted`,
      ]),
    );
  });

  it("records a tax exemption reason added, changed and deleted", async () => {
    const made = await call(exemptReasonsRoute, "owner", { body: { name: "Resale" } });
    expect(made.status).toBe(201);
    const query = { id: String(made.body.id) };
    await call(exemptReasonRoute, "owner", { method: "PUT", query, body: { name: "Resale cert" } });
    await call(exemptReasonRoute, "owner", { method: "DELETE", query });
    const entries = await prisma.auditEntry.findMany({
      where: { event: "TAX_CHANGED" },
      orderBy: { id: "asc" },
    });
    expect(entries.map((e) => e.summary)).toEqual([
      `Tax exemption reason ${made.body.id} added`,
      `Tax exemption reason ${made.body.id} changed`,
      `Tax exemption reason ${made.body.id} deleted`,
    ]);
  });

  it("records a vendor's cost moving, and nothing when it stays put", async () => {
    const product = await makeProduct("V-1");
    const source = await prisma.productSource.create({
      data: { productId: product.id, vendorId: product.vendorId, cost: 50 },
    });
    const query = { id: String(product.id), sourceId: String(source.id) };
    await call(sourceRoute, "owner", { method: "PATCH", query, body: { cost: 50 } });
    expect(await prisma.auditEntry.count()).toBe(0);
    const res = await call(sourceRoute, "owner", { method: "PATCH", query, body: { cost: 60 } });
    expect(res.status).toBe(200);
    expect((await onlyEntry("PRODUCT_COST_CHANGED")).summary).toBe("Vendor cost 50 → 60");
  });

  it("records a vendor style's price moving, and nothing for its name", async () => {
    const product = await makeProduct("V-2");
    const style = await prisma.vendorStyle.create({
      data: { vendorId: product.vendorId, styleNumber: "ST-1", name: "Harbor", baseRetail: 100 },
    });
    const query = { id: String(style.id) };
    await call(styleRoute, "owner", {
      method: "PUT",
      query,
      body: { fields: { description: "Comfortable" } },
    });
    expect(await prisma.auditEntry.count()).toBe(0);
    const res = await call(styleRoute, "owner", {
      method: "PUT",
      query,
      body: { fields: { baseRetail: 120 } },
    });
    expect(res.status).toBe(200);
    expect((await onlyEntry("STYLE_PRICE_CHANGED")).summary).toBe("Harbor: baseRetail changed");
  });

  it("records a vendor merged", async () => {
    const from = await prisma.vendor.create({ data: { name: "Old Name" } });
    const into = await prisma.vendor.create({ data: { name: "New Name" } });
    const res = await call(vendorMergeRoute, "owner", {
      query: { id: String(from.id) },
      body: { intoId: into.id },
    });
    expect(res.status).toBe(200);
    expect((await onlyEntry("VENDORS_MERGED")).summary).toBe(
      `Vendor ${from.id} merged into vendor ${into.id}`,
    );
  });
});

describe("the one list", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date("2026-11-06T17:00:00Z");
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
  const filter = (over: Partial<AuditFilter> = {}): AuditFilter => ({
    ...auditFilterFrom({}),
    ...over,
  });

  async function entry(days: number, actor = "pat@example.com", event = "SETTINGS_SAVED") {
    await prisma.auditEntry.create({
      data: { event, actor, summary: `${event} ${days}`, created: ago(days) },
    });
  }

  async function everyHistory() {
    const order = await makeOrder();
    const product = await makeProduct("L-1");
    const card = await prisma.giftCard.create({
      data: { barcode: "SPEND-ME-1234", initialAmount: 50, currentBalance: 50 },
    });
    const customer = await prisma.customer.findFirstOrThrow();
    const staff = await prisma.staffMember.findFirstOrThrow({ where: { userId: "owner" } });
    const payout = await prisma.commissionPayout.create({
      data: {
        staffMemberId: staff.id,
        periodStart: ago(30),
        periodEnd: ago(1),
        periodSalesAmount: 0,
        ytdSalesAtStart: 0,
        ytdSalesAtEnd: 0,
        tierBreakdown: [],
        commissionAmount: 0,
        tierDefinitionSnapshot: [],
      },
    });
    await entry(1);
    await prisma.orderChangeLog.create({
      data: {
        salesOrderId: order.id,
        changeType: "PRICE_CHANGE",
        previousValue: "100",
        newValue: "90",
        reason: "price match",
        changedBy: "pat@example.com",
        created: ago(2),
      },
    });
    await prisma.giftCardTransaction.create({
      data: {
        giftCardId: card.id,
        transactionType: "RELOAD",
        amount: 5,
        balanceBefore: 50,
        balanceAfter: 55,
        createdBy: "pat@example.com",
        created: ago(3),
      },
    });
    await prisma.customerCreditTransaction.create({
      data: {
        customerId: customer.id,
        type: "ADJUSTMENT",
        amount: 10,
        balanceBefore: 0,
        balanceAfter: 10,
        createdBy: "pat@example.com",
        created: ago(4),
      },
    });
    await prisma.commissionPayoutEdit.create({
      data: {
        payoutId: payout.id,
        fieldChanged: "commissionAmount",
        oldValue: 1,
        newValue: 2,
        reason: "corrected",
        editedBy: "pat@example.com",
        editedAt: ago(5),
      },
    });
    await moveStock(product.id, "pat@example.com", ago(6));
    await prisma.configChangeLog.create({
      data: {
        presetKind: "tenders",
        presetName: "standard",
        action: "UPDATED",
        source: "ui",
        summary: {},
        actor: "pat@example.com",
        created: ago(7),
      },
    });
    return { order, product, card, customer };
  }

  it("merges every history, newest first, with each one's own wording and link", async () => {
    const { order, product, card, customer } = await everyHistory();
    const { rows, hasMore } = await loadAuditFeed(filter(), STORE);
    expect(hasMore).toBe(false);
    expect(rows.map((r) => r.what)).toEqual([
      "Store settings saved",
      "Price/Qty Changed",
      "Gift card",
      "Store credit",
      "Commission payout edited",
      "Stock moved",
      "Configuration applied",
    ]);
    expect(rows.every((r) => r.who === "pat@example.com")).toBe(true);
    expect(rows[1].summary).toBe(`${order.orderno}: 100 → 90. price match`);
    expect(rows[1].href).toBe(`/app/sales/orders/${order.id}`);
    expect(rows[2].href).toBe(`/app/admin/gift-cards/${card.id}`);
    expect(rows[3].href).toBe(`/app/sales/customers/${customer.id}`);
    expect(rows[5].href).toBe(`/app/inventory/products/${product.id}`);
  });

  it("never shows a gift card's barcode, which is what spends it", async () => {
    await everyHistory();
    const { rows } = await loadAuditFeed(filter(), STORE);
    expect(JSON.stringify(rows)).not.toContain("SPEND-ME");
  });

  it.each([
    ["sales", ["Price/Qty Changed", "Gift card", "Store credit"]],
    ["books", ["Commission payout edited"]],
    ["stock", ["Stock moved"]],
    ["settings", ["Store settings saved", "Configuration applied"]],
    ["prices", []],
  ] as const)("shows only %s when asked", async (group, expected) => {
    await everyHistory();
    const { rows } = await loadAuditFeed(filter({ group }), STORE);
    expect(rows.map((r) => r.what)).toEqual(expected);
    expect(rows.every((r) => r.group === group)).toBe(true);
  });

  it("finds a person by part of their email, in any case, in every history", async () => {
    await everyHistory();
    await entry(1, "sam@example.com");
    const { rows } = await loadAuditFeed(filter({ who: "SAM@" }), STORE);
    expect(rows.map((r) => r.who)).toEqual(["sam@example.com"]);
    const pat = await loadAuditFeed(filter({ who: "pat" }), STORE);
    expect(pat.rows).toHaveLength(7);
  });

  it("takes dates as whole days in the store's time, in every history", async () => {
    await everyHistory();
    // Two to four days back from 2026-11-06 12:00 New York.
    const { rows } = await loadAuditFeed(
      filter({ fromDay: "2026-11-02", toDay: "2026-11-04" }),
      STORE,
    );
    expect(rows.map((r) => r.what)).toEqual(["Price/Qty Changed", "Gift card", "Store credit"]);
  });

  it("keeps each history to the dates asked for", async () => {
    await everyHistory();
    // Three to five days back: each history above has one row on its own day.
    const { rows } = await loadAuditFeed(
      filter({ fromDay: "2026-11-01", toDay: "2026-11-03" }),
      STORE,
    );
    expect(rows.map((r) => r.what)).toEqual([
      "Gift card",
      "Store credit",
      "Commission payout edited",
    ]);
  });

  it("counts a late evening as that day, not the next", async () => {
    // 11 PM in New York on the 4th is already the 5th in UTC.
    await prisma.auditEntry.create({
      data: {
        event: "SETTINGS_SAVED",
        actor: "pat",
        summary: "late",
        created: new Date("2026-11-05T04:00:00Z"),
      },
    });
    const on4th = await loadAuditFeed(
      filter({ fromDay: "2026-11-04", toDay: "2026-11-04" }),
      STORE,
    );
    expect(on4th.rows).toHaveLength(1);
    const on5th = await loadAuditFeed(
      filter({ fromDay: "2026-11-05", toDay: "2026-11-05" }),
      STORE,
    );
    expect(on5th.rows).toHaveLength(0);
  });

  it("says when a history recorded nobody, rather than guessing", async () => {
    const order = await makeOrder();
    await prisma.orderChangeLog.create({
      data: { salesOrderId: order.id, changeType: "STATUS_CHANGE", changedBy: null },
    });
    const { rows } = await loadAuditFeed(filter(), STORE);
    expect(rows[0].who).toBeNull();
  });

  it("leaves out stock the system moved by itself", async () => {
    const product = await makeProduct("L-1");
    await moveStock(product.id, null);
    await moveStock(product.id, "nightly-import");
    expect((await loadAuditFeed(filter(), STORE)).rows).toEqual([]);
  });

  it("pages through everything across histories, missing and repeating nothing", async () => {
    const order = await makeOrder();
    for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i++) {
      await prisma.auditEntry.create({
        data: { event: "DATA_EXPORTED", actor: "pat", summary: `a${i}`, created: ago(i * 2) },
      });
      await prisma.orderChangeLog.create({
        data: {
          salesOrderId: order.id,
          changeType: "LINE_NOTE",
          changedBy: "pat",
          created: ago(i * 2 + 1),
        },
      });
    }
    const total = (AUDIT_PAGE_SIZE + 5) * 2;
    const first = await loadAuditFeed(filter({ page: 1 }), STORE);
    const second = await loadAuditFeed(filter({ page: 2 }), STORE);
    const third = await loadAuditFeed(filter({ page: 3 }), STORE);
    expect(first.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(second.hasMore).toBe(true);
    expect(third.rows).toHaveLength(total - 2 * AUDIT_PAGE_SIZE);
    expect(third.hasMore).toBe(false);
    const keys = [...first.rows, ...second.rows, ...third.rows].map((r) => r.key);
    expect(new Set(keys).size).toBe(total);
    const times = [...first.rows, ...second.rows, ...third.rows].map((r) => r.when.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("knows there's more when one history alone runs past the page", async () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        event: "DATA_EXPORTED",
        actor: "pat",
        summary: `a${i}`,
        created: ago(i),
      }));
    await prisma.auditEntry.createMany({ data: entries(AUDIT_PAGE_SIZE) });
    expect((await loadAuditFeed(filter(), STORE)).hasMore).toBe(false);

    await prisma.auditEntry.create({
      data: { event: "DATA_EXPORTED", actor: "pat", summary: "one more", created: ago(100) },
    });
    const { rows, hasMore } = await loadAuditFeed(filter(), STORE);
    expect(rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(hasMore).toBe(true);
  });

  it("orders an unknown old event in the data group, rather than failing", async () => {
    await prisma.auditEntry.create({
      data: { event: "RETIRED_EVENT", actor: "pat", summary: "old" },
    });
    const { rows } = await loadAuditFeed(filter(), STORE);
    expect(rows[0]).toMatchObject({ what: "RETIRED_EVENT", group: "data" });
  });
});

describe("the screen", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ get: () => undefined, getAll: () => [] });
    const session = { user: { id: who, email: `${who}@example.com` } };
    (getServerSession as jest.Mock).mockResolvedValue(session);
    (getServerSessionNext as jest.Mock).mockResolvedValue(session);
  }

  it("shows an admin the list, with the filter from the URL", async () => {
    signIn("boss");
    await prisma.auditEntry.create({
      data: { event: "DATA_EXPORTED", actor: "pat@example.com", summary: "out" },
    });
    await prisma.auditEntry.create({
      data: { event: "DATA_EXPORTED", actor: "sam@example.com", summary: "too" },
    });
    const element = await AuditTrailPage({ searchParams: Promise.resolve({ who: "pat" }) });
    expect(element.props.filter.who).toBe("pat");
    expect(element.props.feed.rows.map((r: { summary: string }) => r.summary)).toEqual(["out"]);
  });

  it("sends anyone without the permission away", async () => {
    signIn("till");
    await expect(AuditTrailPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(/REDIRECT/);
  });
});
