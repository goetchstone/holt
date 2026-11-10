// __tests__/integration/helpCenter.integration.test.ts
//
// The help center (GAP-30, DECISIONS 54) through its real route and pages: anyone signed
// in reads help, the "?" finds the screen's article, and nothing answers a stranger.
// Only the session readers are stood in for.

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
  notFound: jest.fn(() => {
    throw new Error("NOT FOUND");
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getServerSession as getServerSessionNext } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { HELP_ARTICLES } from "@/lib/help/catalog";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import route from "@/pages/api/help/article";
import HelpPage from "@/app/(dashboard)/app/help/page";
import HelpArticlePage from "@/app/(dashboard)/app/help/[slug]/page";

function signIn(who: string | null) {
  (getToken as jest.Mock).mockResolvedValue(who ? { id: who } : null);
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ get: () => undefined, getAll: () => [] });
  const session = who ? { user: { id: who, email: `${who}@example.com` } } : null;
  (getServerSession as jest.Mock).mockResolvedValue(session);
  (getServerSessionNext as jest.Mock).mockResolvedValue(session);
}

async function ask(method: string, screen?: unknown) {
  let status = 200;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
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
    { method, query: screen === undefined ? {} : { screen }, headers: {} } as never,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload };
}

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, appName: "Holt" } });
  invalidateAppSettingsCache();
  // The least-trusted role there is: help is for everyone who works at the store.
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "REGISTER" } });
  await prisma.user.create({ data: { id: "till", email: "till@example.com" } });
  await prisma.staffMember.create({
    data: {
      userId: "till",
      email: "till@example.com",
      displayName: "till",
      role: "REGISTER",
      roleId: role.id,
      defaultStore: "Main Street",
    },
  });
});

describe("the ? on a screen", () => {
  it("opens the article for that screen, ids and all", async () => {
    signIn("till");
    const res = await ask("GET", "/app/sales/orders/42");
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("cancelling-and-changing-a-sale");
    expect(res.body.title).toBe("Cancelling or changing a sale");
    expect(res.body.html).toContain("<h2>Cancelling a whole sale</h2>");
  });

  it("says when a screen has no article yet", async () => {
    signIn("till");
    const res = await ask("GET", "/app/inventory");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("no help article yet");
  });

  it("answers nobody who isn't signed in", async () => {
    signIn(null);
    expect((await ask("GET", "/app/admin/audit")).status).toBe(401);
  });

  it("only reads", async () => {
    signIn("till");
    expect((await ask("POST", "/app/admin/audit")).status).toBe(405);
  });

  it("can't be pointed at a file", async () => {
    signIn("till");
    expect((await ask("GET", "/../package.json")).status).toBe(404);
    expect((await ask("GET", ["/app/admin/audit"])).status).toBe(404);
  });
});

describe("the help pages", () => {
  it("list every article, with its words for search, to anyone at the store", async () => {
    signIn("till");
    const page = await HelpPage();
    expect(page.props.articles.map((a: { slug: string }) => a.slug)).toEqual(
      HELP_ARTICLES.map((a) => a.slug),
    );
    expect(page.props.articles[0].text).toContain("Choose the vendor");
  });

  it("show one article", async () => {
    signIn("till");
    const page = await HelpArticlePage({ params: Promise.resolve({ slug: "audit-trail" }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children = page.props.children as { type: unknown; props: any }[];
    expect(children.find((c) => c.type === "h1")?.props.children).toBe("Finding who did what");
    const body = children.find((c) => c.props?.dangerouslySetInnerHTML);
    expect(body?.props.dangerouslySetInnerHTML.__html).toContain("<h2>What it shows</h2>");
  });

  it("don't exist for a slug that isn't an article", async () => {
    signIn("till");
    await expect(
      HelpArticlePage({ params: Promise.resolve({ slug: "../package" }) }),
    ).rejects.toThrow("NOT FOUND");
  });

  it("send a stranger to sign in", async () => {
    signIn(null);
    await expect(HelpPage()).rejects.toThrow(/REDIRECT/);
  });
});
