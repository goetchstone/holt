// /app/__tests__/integration/customerSearch.integration.test.ts
//
// Customer search reads the matches GET /api/customers actually sends.
//
// Found 2026-11-03: the new house call form and the order page's "Add
// Customer" field ran their own searches and read `customers` from an answer
// shaped `{ data, totalPages }`. The house call list was always empty; the
// order page took the whole answer as its list and rendered nothing. Both now
// go through useCustomerSearch, whose reader this test holds to the real route.
//
// Real route, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { customerSearchRows } from "@/hooks/useCustomerSearch";
import customersRoute from "@/pages/api/customers/index";

const owner = { user: { id: "owner", email: "owner@example.com" } } as unknown as Session;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: unknown;
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
    setHeader() {
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function search(query: Record<string, string>) {
  const res = makeRes();
  const req = { method: "GET", query, cookies: {}, headers: {} } as unknown as NextApiRequest;
  await customersRoute(req, res);
  return res;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: {
      userId: "owner",
      email: "owner@example.com",
      displayName: "Owner",
      role: "ADMIN",
      roleId: role.id,
    },
  });
  (getServerSession as jest.Mock).mockResolvedValue(owner);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Customer search", () => {
  it("finds the customer typed, at each screen's page size", async () => {
    const ada = await prisma.customer.create({
      data: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "555-0100" },
    });
    await prisma.customer.create({ data: { firstName: "Grace", lastName: "Hopper" } });

    // House calls ask for 10 matches, the order page for 8.
    for (const limit of ["10", "8"]) {
      const res = await search({ search: "lovelace", limit });
      expect(res.statusCode).toBe(200);
      expect(customerSearchRows(res.body)).toEqual([
        expect.objectContaining({
          id: ada.id,
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phone: "555-0100",
        }),
      ]);
    }
  });

  it("carries each match's saved addresses, which the house call form offers", async () => {
    const ada = await prisma.customer.create({
      data: { firstName: "Ada", lastName: "Lovelace" },
    });
    const home = await prisma.customerAddress.create({
      data: {
        customerId: ada.id,
        label: "Home",
        address1: "12 Analytical Way",
        city: "Springfield",
        state: "IL",
        zip: "62704",
      },
    });

    const res = await search({ search: "lovelace", limit: "10" });

    // The form called a GET the addresses route never had, then read `street`
    // from rows whose column is `address1`: its picker could never fill.
    expect(customerSearchRows(res.body)[0].addresses).toEqual([
      expect.objectContaining({
        id: home.id,
        label: "Home",
        address1: "12 Analytical Way",
        city: "Springfield",
        state: "IL",
        zip: "62704",
      }),
    ]);
  });

  it("finds no one in an answer that carries no matches", () => {
    expect(customerSearchRows({ error: "Failed to fetch customers" })).toEqual([]);
    expect(customerSearchRows(null)).toEqual([]);
  });
});
