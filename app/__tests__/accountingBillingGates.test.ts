// /app/__tests__/accountingBillingGates.test.ts
//
// PLACEHOLDER TEST — Grade: B (real gates, resolver and catalog; mocked SQL).
// Prisma answers only the caller's staff row (a built-in role with no linked
// Role) and an empty Role table, so each decision is the one a deployment makes
// for its unedited built-in roles. Upgrade path: the billing router's key is
// pinned against a real database in billingRouter.integration.test.ts (General
// Manager refused, Manager admitted); a real-DB sibling for the REST routes
// would seed each built-in role and call each route.
//
// Who may call the chart-of-accounts, journal-entry, invoice, payment-link and
// portal-link endpoints now that they gate on permission keys instead of role
// lists (the 2026-11 role-list sweep). Every built-in role is put through each
// route's and procedure's real gate (requirePermission, permissionProcedure),
// so a route that takes the wrong key for a method, or a catalog grant that
// changes, changes who gets through and fails here. Nothing behind a gate
// runs: a REST route's handler is swapped for a stub answering 299, and the
// billing and client-portal modules read as off, so a procedure that admits
// answers NOT_FOUND and one that refuses answers FORBIDDEN.
//
// Each expected list is the old role list's audience (a list naming ADMIN also
// admitted SUPER_ADMIN), with any difference stated beside it.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    staffMember: { findFirst: jest.fn(), count: jest.fn() },
    role: { findMany: jest.fn() },
    cacheGeneration: { findMany: jest.fn() },
  },
}));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("@/lib/modules/requireModule", () => ({ isModuleEnabled: async () => false }));
jest.mock("@/lib/logger", () => ({
  ...jest.requireActual("@/lib/logger"),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logError: jest.fn(),
}));
jest.mock("@/lib/auth/requireAuth", () => {
  const actual = jest.requireActual("@/lib/auth/requireAuth");
  // The real gate, in front of a stub instead of the route's own handler.
  const admitted = async (_req: unknown, res: { status: (code: number) => { end: () => void } }) =>
    res.status(299).end();
  return {
    ...actual,
    requirePermission: (permission: unknown, _handler: unknown, options: unknown) =>
      actual.requirePermission(permission, admitted, options),
  };
});

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { BUILT_IN_ROLES } from "@/lib/auth/permissionCatalog";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { createCallerFactory } from "@/server/trpc/trpc";
import { billingRouter } from "@/server/trpc/routers/billing";
import { clientPortalRouter } from "@/server/trpc/routers/clientPortal";
import accountGroups from "@/pages/api/accounting/account-groups/index";
import accountGroup from "@/pages/api/accounting/account-groups/[id]";
import glAccounts from "@/pages/api/accounting/gl-accounts/index";
import glAccount from "@/pages/api/accounting/gl-accounts/[id]";
import systemGlMappings from "@/pages/api/accounting/system-gl-mappings";
import journalEntry from "@/pages/api/accounting/journal-entries/[id]";
import exportJournal from "@/pages/api/accounting/export-journal";
import ledgerBackfill from "@/pages/api/admin/customer-ledger/backfill";
import ledgerCustomerIds from "@/pages/api/admin/customer-ledger/customer-ids";
import invoicePdf from "@/pages/api/billing/invoices/[id]/pdf";
import portalLink from "@/pages/api/portal/generate-link";
import createCheckout from "@/pages/api/stripe/create-checkout";
import sendPaymentLink from "@/pages/api/stripe/send-payment-link";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Call = (role: string) => Promise<unknown>;

const ROLES = BUILT_IN_ROLES.map((r) => r.key);
const only = (...roles: string[]) => [...roles].sort();
// requireAuthWithRole(["MANAGER", "ADMIN"]), BILLING_ROLES and PORTAL_ROLES.
const MANAGER_ADMIN = ["SUPER_ADMIN", "ADMIN", "MANAGER"];

beforeEach(() => {
  invalidateRoleGrantCache();
  (prisma.role.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.cacheGeneration.findMany as jest.Mock).mockResolvedValue([]);
  // A privileged staff member exists, so the bootstrap safeguard never waives a refusal.
  (prisma.staffMember.count as jest.Mock).mockResolvedValue(1);
});

function signInAs(role: string) {
  (getServerSession as jest.Mock).mockResolvedValue({ user: { id: `user-${role}` } });
  (prisma.staffMember.findFirst as jest.Mock).mockResolvedValue({ role, roleId: null });
}

async function statusOf(route: Route, method: string): Promise<number> {
  let status = 0;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
    end: () => res,
    setHeader: () => res,
  };
  const req = { method, query: { id: "1" }, body: {}, cookies: {}, headers: {} };
  await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return status;
}

/** The built-in roles a route's gate lets through for `method`. */
async function admittedBy(route: Route, method: string): Promise<string[]> {
  const admitted: string[] = [];
  for (const role of ROLES) {
    signInAs(role);
    const status = await statusOf(route, method);
    if (status === 299) admitted.push(role);
    else if (status !== 403)
      throw new Error(`${role} ${method}: answered ${status}, not 299 or 403`);
  }
  return admitted.sort();
}

/** The built-in roles a procedure's gate lets through. */
async function admittedByProcedure(call: Call): Promise<string[]> {
  const admitted: string[] = [];
  for (const role of ROLES) {
    signInAs(role);
    const code = await call(role).then(
      () => "OK",
      (err: { code?: string }) => err.code,
    );
    if (code === "NOT_FOUND") admitted.push(role);
    else if (code !== "FORBIDDEN")
      throw new Error(`${role}: answered ${code}, not a gate's answer`);
  }
  return admitted.sort();
}

describe("the chart of accounts", () => {
  // Writes stay on exactly the old list: Managers make them through "Set up the
  // chart of accounts", and no one else gains them.
  const writes: Array<[string, string, Route]> = [
    ["account-groups", "POST", accountGroups],
    ["account-groups/[id]", "PUT", accountGroup],
    ["account-groups/[id]", "DELETE", accountGroup],
    ["gl-accounts", "POST", glAccounts],
    ["gl-accounts/[id]", "PUT", glAccount],
    ["gl-accounts/[id]", "DELETE", glAccount],
    ["system-gl-mappings", "PUT", systemGlMappings],
  ];
  it.each(writes)(
    "%s %s admits the old MANAGER/ADMIN list and no one else",
    async (_, m, route) => {
      expect(await admittedBy(route, m)).toEqual(only(...MANAGER_ADMIN));
    },
  );

  // Reads add General Manager through View accounting.
  const reads: Array<[string, Route]> = [
    ["gl-accounts", glAccounts],
    ["gl-accounts/[id]", glAccount],
    ["system-gl-mappings", systemGlMappings],
  ];
  it.each(reads)("GET %s adds General Manager, who holds View accounting", async (_, route) => {
    expect(await admittedBy(route, "GET")).toEqual(only(...MANAGER_ADMIN, "GENERAL_MANAGER"));
  });

  // The account-group list also fills the Account Group picker on the category
  // editor, so catalog editors read it, as they read tax groups for that form.
  const groupReads: Array<[string, Route]> = [
    ["account-groups", accountGroups],
    ["account-groups/[id]", accountGroup],
  ];
  it.each(groupReads)("GET %s adds View accounting and Edit catalog holders", async (_, route) => {
    expect(await admittedBy(route, "GET")).toEqual(
      only(...MANAGER_ADMIN, "GENERAL_MANAGER", "DEPARTMENT_HEAD", "BUYER", "DATA_ENTRY"),
    );
  });
});

describe("a journal entry", () => {
  // Opening one is View accounting, the Journal Entries screen's key; posting,
  // marking exported and deleting a draft are Post journals, which Managers hold
  // so they keep posting the daily journal. General Manager could open the
  // screen but not an entry on it; now it can do both.
  it.each(["GET", "PUT", "DELETE"])("%s adds General Manager", async (method) => {
    expect(await admittedBy(journalEntry, method)).toEqual(
      only(...MANAGER_ADMIN, "GENERAL_MANAGER"),
    );
  });
});

describe("the screens on Change settings", () => {
  // Post journals gated these before; Managers now hold it, so they move to
  // their screens' key and the grant opens nothing else. General Manager loses
  // a path it had only by API.
  const routes: Array<[string, string, Route]> = [
    ["accounting/export-journal", "GET", exportJournal],
    ["admin/customer-ledger/backfill", "POST", ledgerBackfill],
    ["admin/customer-ledger/customer-ids", "GET", ledgerCustomerIds],
  ];
  it.each(routes)("%s %s admits only the Owner and Administrator", async (_, method, route) => {
    expect(await admittedBy(route, method)).toEqual(only("SUPER_ADMIN", "ADMIN"));
  });
});

describe("taking payment on an order", () => {
  // Take payment, the key recording an order payment already takes: the
  // Register and General Manager gain card links.
  const routes: Array<[string, Route]> = [
    ["stripe/send-payment-link", sendPaymentLink],
    ["stripe/create-checkout", createCheckout],
  ];
  it.each(routes)("POST %s adds Register and General Manager", async (_, route) => {
    expect(await admittedBy(route, "POST")).toEqual(
      only(...MANAGER_ADMIN, "GENERAL_MANAGER", "REGISTER"),
    );
  });

  it("POST portal/generate-link keeps its list and adds General Manager", async () => {
    // Write orders, the key that texts the customer the same link. The old list
    // was DESIGNER, REGISTER, MANAGER and ADMIN.
    expect(await admittedBy(portalLink, "POST")).toEqual(
      only(...MANAGER_ADMIN, "DESIGNER", "REGISTER", "GENERAL_MANAGER"),
    );
  });
});

describe("billing customers directly", () => {
  // Every billing procedure, the client-hub link and the invoice PDF take Bill
  // customers directly: exactly BILLING_ROLES and PORTAL_ROLES. General
  // Manager, who holds View accounting and Post journals, stays out.
  const draft = { customerId: 1, lines: [{ description: "x", quantity: 1, unitPrice: 1 }] };
  const billing = (role: string) =>
    createCallerFactory(billingRouter)({
      userId: `user-${role}`,
      userEmail: null,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });
  const portal = (role: string) =>
    createCallerFactory(clientPortalRouter)({
      userId: `user-${role}`,
      userEmail: null,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });
  const billingCalls: Array<[string, Call]> = [
    ["list", (r) => billing(r).list({})],
    ["detail", (r) => billing(r).detail({ id: 1 })],
    ["create", (r) => billing(r).create(draft)],
    ["update", (r) => billing(r).update({ ...draft, id: 1 })],
    ["delete", (r) => billing(r).delete({ id: 1 })],
    ["issue", (r) => billing(r).issue({ id: 1 })],
    ["void", (r) => billing(r).void({ id: 1 })],
    ["recordPayment", (r) => billing(r).recordPayment({ id: 1, amount: 1, method: "CHECK" })],
    ["tenders", (r) => billing(r).tenders()],
    ["paymentLink", (r) => billing(r).paymentLink({ id: 1 })],
    ["sendEmail", (r) => billing(r).sendEmail({ id: 1 })],
  ];

  it("covers every billing procedure", () => {
    const procedures = Object.keys(
      (billingRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures,
    );
    expect(procedures.sort()).toEqual(billingCalls.map(([name]) => name).sort());
  });

  it.each(billingCalls)("billing.%s admits the old BILLING_ROLES", async (_, call) => {
    expect(await admittedByProcedure(call)).toEqual(only(...MANAGER_ADMIN));
  });

  it("clientPortal.generateLink admits the old PORTAL_ROLES", async () => {
    expect(await admittedByProcedure((r) => portal(r).generateLink({ customerId: 1 }))).toEqual(
      only(...MANAGER_ADMIN),
    );
  });

  it("GET billing/invoices/[id]/pdf drops General Manager, who could not open the invoice", async () => {
    // It was View accounting, wider than the screen that links to it.
    expect(await admittedBy(invoicePdf, "GET")).toEqual(only(...MANAGER_ADMIN));
  });
});

describe("a store's own role is decided by the keys it holds", () => {
  // Staff on a custom role carry the enum DESIGNER, which none of the old lists
  // here named, so they were refused whatever the role allowed. Now the keys
  // ticked on the role decide. View accounting and Post journals have the same
  // built-in holders, so only a role holding one without the other shows which
  // key a journal entry's PUT and DELETE take.
  function signInOnStoreRole(...keys: string[]) {
    (prisma.role.findMany as jest.Mock).mockResolvedValue([
      {
        id: 99,
        key: "STORE_ROLE",
        rank: 0,
        grantsAllPermissions: false,
        permissions: keys.map((permission) => ({ permission })),
      },
    ]);
    invalidateRoleGrantCache();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: "user-store-role" } });
    (prisma.staffMember.findFirst as jest.Mock).mockResolvedValue({ role: "DESIGNER", roleId: 99 });
  }

  it("View accounting opens entries and reads the chart, but posts and sets up nothing", async () => {
    signInOnStoreRole("accounting.read");
    expect(await statusOf(journalEntry, "GET")).toBe(299);
    expect(await statusOf(journalEntry, "PUT")).toBe(403);
    expect(await statusOf(journalEntry, "DELETE")).toBe(403);
    expect(await statusOf(glAccounts, "GET")).toBe(299);
    expect(await statusOf(glAccounts, "POST")).toBe(403);
    expect(await statusOf(invoicePdf, "GET")).toBe(403);
  });

  it("Post journals posts and deletes an entry", async () => {
    signInOnStoreRole("accounting.post");
    expect(await statusOf(journalEntry, "PUT")).toBe(299);
    expect(await statusOf(journalEntry, "DELETE")).toBe(299);
    expect(await statusOf(exportJournal, "GET")).toBe(403);
  });

  it("Set up the chart of accounts makes the chart writes on its own", async () => {
    signInOnStoreRole("accounting.chart.manage");
    const writes: Array<[Route, string]> = [
      [accountGroups, "POST"],
      [accountGroup, "PUT"],
      [accountGroup, "DELETE"],
      [glAccounts, "POST"],
      [glAccount, "PUT"],
      [glAccount, "DELETE"],
      [systemGlMappings, "PUT"],
    ];
    for (const [route, method] of writes) {
      expect({ method, status: await statusOf(route, method) }).toEqual({ method, status: 299 });
    }
  });

  it("Bill customers directly opens the billing router and the invoice PDF", async () => {
    signInOnStoreRole("accounting.invoice");
    const caller = createCallerFactory(billingRouter)({
      userId: "user-store-role",
      userEmail: null,
      tokenRole: null,
      impersonate: null,
      headers: new Headers(),
    });
    await expect(caller.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await statusOf(invoicePdf, "GET")).toBe(299);
  });
});
