// __tests__/integration/emailLook.integration.test.ts
//
// GAP-37: what a store sets for its emails reaches what actually gets queued. Real routes
// and database; only the session readers are mocked.

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
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { getEmailChrome, getEmailWordings } from "@/lib/email/wordingSettings";
import { queueLowStockAlert } from "@/lib/purchasing/lowStockAlert";
import { queueFollowUpEmails } from "@/lib/followUpEmail";
import settingsRoute from "@/pages/api/admin/settings";
import kindRoute from "@/pages/api/admin/email-look/[kind]";
import EmailLookPage from "@/app/(dashboard)/app/admin/setup/email-look/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

async function call(
  route: Route,
  who: string,
  {
    method = "PUT",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: who, email: `${who}@example.com` },
  });
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
  return { status, body: payload as Body };
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

const app = () => prisma.appSettings.findFirstOrThrow();

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: {
      organizationId: DEFAULT_ORG_ID,
      orderNumberPrefix: "TST",
      timezone: "UTC",
      companyName: "Linden Row Home",
    },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  // Permissions are bypassed while no active admin exists, so one always does here.
  await makeStaff("owner", "ADMIN");
});

describe("the look, through Settings", () => {
  it("saves and reaches an email's chrome", async () => {
    const saved = await call(settingsRoute, "owner", {
      body: { emailAccentColor: "#7a3e1d", emailShowLogo: true, emailFooter: " Thanks! " },
    });
    expect(saved.status).toBe(200);
    expect(await app()).toMatchObject({
      emailAccentColor: "#7a3e1d",
      emailShowLogo: true,
      emailFooter: "Thanks!",
    });
    invalidateAppSettingsCache();
    const { look } = await getEmailChrome("invoice");
    expect(look.accent).toBe("#7a3e1d");
    expect(look.footer).toBe("Thanks!");
  });

  it("refuses a colour that isn't a plain six-digit one, saying why", async () => {
    for (const bad of ["red", "#fff", 'x";background:url(//evil)', 5]) {
      const res = await call(settingsRoute, "owner", { body: { emailAccentColor: bad } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/colour/);
    }
    expect((await app()).emailAccentColor).toBeNull();
  });

  it("the database won't hold one either", async () => {
    await expect(
      prisma.appSettings.updateMany({ data: { emailAccentColor: "red" } }),
    ).rejects.toThrow();
  });

  it("refuses a logo setting that isn't true or false, and a foot that isn't text or is too long", async () => {
    expect((await call(settingsRoute, "owner", { body: { emailShowLogo: "yes" } })).status).toBe(
      400,
    );
    expect((await call(settingsRoute, "owner", { body: { emailFooter: 5 } })).status).toBe(400);
    const long = await call(settingsRoute, "owner", { body: { emailFooter: "x".repeat(1001) } });
    expect(long.status).toBe(400);
  });

  it("a blank foot or no colour goes back to the default", async () => {
    await call(settingsRoute, "owner", {
      body: { emailAccentColor: "#7a3e1d", emailFooter: "Thanks!" },
    });
    await call(settingsRoute, "owner", { body: { emailAccentColor: null, emailFooter: "  " } });
    expect(await app()).toMatchObject({ emailAccentColor: null, emailFooter: null });
  });
});

describe("the wording", () => {
  const change = (kind: string, body: object) =>
    call(kindRoute, "owner", { query: { kind }, body });

  it("saves what a store changed, with who, and leaves the rest as suggested", async () => {
    const saved = await change("invoice", { closing: "Thanks for your business." });
    expect(saved.status).toBe(200);
    const row = await prisma.emailWording.findUniqueOrThrow({ where: { key: "invoice" } });
    expect(row).toMatchObject({
      closing: "Thanks for your business.",
      subject: null,
      intro: null,
      updatedBy: "owner@example.com",
    });
    expect((await getEmailChrome("invoice")).wording.closing).toBe("Thanks for your business.");
    expect((await getEmailChrome("booking")).wording).toEqual({});
    expect(await getEmailWordings()).toHaveProperty("invoice");
  });

  it("saves over what's there", async () => {
    await change("invoice", { closing: "First" });
    await change("invoice", { closing: "Second" });
    expect(await prisma.emailWording.count()).toBe(1);
    expect((await getEmailChrome("invoice")).wording.closing).toBe("Second");
  });

  it("blank is the suggested wording", async () => {
    await change("invoice", { closing: "   " });
    expect((await getEmailChrome("invoice")).wording.closing).toBeNull();
  });

  it("refuses a placeholder this email doesn't have, and saves nothing", async () => {
    const bad = await change("low-stock", { intro: "Hi {customer}" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/\{customer\}/);
    expect(await prisma.emailWording.count()).toBe(0);
  });

  it("refuses anything but text", async () => {
    const bad = await change("invoice", { intro: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/text/);
  });

  it("answers 404 for an email that doesn't exist, whatever's asked", async () => {
    for (const method of ["PUT", "DELETE", "POST"]) {
      const res = await call(kindRoute, "owner", { method, query: { kind: "nope" } });
      expect(res.status).toBe(404);
    }
  });

  it("goes back to the suggested wording", async () => {
    await change("invoice", { closing: "Mine" });
    const back = await call(kindRoute, "owner", { method: "DELETE", query: { kind: "invoice" } });
    expect(back.status).toBe(200);
    expect(await prisma.emailWording.count()).toBe(0);
    expect((await getEmailChrome("invoice")).wording).toEqual({});
  });

  it("is only for those who may change settings", async () => {
    await makeStaff("pat", "DESIGNER");
    for (const method of ["PUT", "DELETE", "POST"]) {
      const res = await call(kindRoute, "pat", { method, query: { kind: "invoice" } });
      expect(res.status).toBe(403);
    }
    expect(await prisma.emailWording.count()).toBe(0);
  });

  it("only takes what it knows", async () => {
    const got = await call(kindRoute, "owner", { method: "GET", query: { kind: "invoice" } });
    expect(got.status).toBe(405);
  });

  it("doesn't let the database's own words out in a 500", async () => {
    jest.spyOn(prisma.emailWording, "upsert").mockRejectedValueOnce(new Error("secret db text"));
    const bad = await change("invoice", { closing: "x" });
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toMatch(/secret db text/);
  });
});

describe("the preview", () => {
  const preview = (kind: string, body: object) =>
    call(kindRoute, "owner", { method: "POST", query: { kind }, body });

  it("shows the unsaved look and wording, and saves neither", async () => {
    const res = await preview("invoice", {
      look: { accent: "#123456", footer: "Foot here", showLogo: false },
      wording: { closing: "Unsaved words" },
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe("Invoice INV-1042 from Linden Row Home");
    expect(res.body.html).toContain("#123456");
    expect(res.body.html).toContain("Foot here");
    expect(res.body.html).toContain("Unsaved words");
    expect(await prisma.emailWording.count()).toBe(0);
    expect((await app()).emailAccentColor).toBeNull();
  });

  it("ignores a colour it can't use rather than putting it in a style", async () => {
    const res = await preview("invoice", { look: { accent: 'x";background:url(//evil)' } });
    expect(res.status).toBe(200);
    expect(res.body.html).not.toContain("evil");
  });

  it("says what's wrong with wording it can't show", async () => {
    const res = await preview("invoice", { wording: { intro: "{nope}" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\{nope\}/);
  });

  it("shows the logo when asked and there is one", async () => {
    await prisma.appSettings.updateMany({ data: { logoUrl: "/uploads/logo.png" } });
    invalidateAppSettingsCache();
    const res = await preview("invoice", { look: { showLogo: true } });
    expect(res.body.html).toMatch(/<img src="[^"]*\/uploads\/logo\.png"/);
  });
});

describe("what gets queued", () => {
  async function aLowProduct() {
    const vendor = await prisma.vendor.create({ data: { name: "Anchor", pricingModel: "FLAT" } });
    const department = await prisma.department.create({ data: { name: "D" } });
    const category = await prisma.category.create({
      data: { name: "Lamps", departmentId: department.id, trackInventory: true },
    });
    const store = await prisma.storeLocation.create({
      data: { name: "Main Street", code: "MS", type: "STORE" },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "OAK-1",
        name: "Oak side table",
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseCost: 10,
      },
    });
    await prisma.reorderPoint.create({
      data: { productId: product.id, storeLocationId: store.id, minQuantity: 3 },
    });
  }

  it("the low stock list comes out in the store's look and words", async () => {
    await aLowProduct();
    await prisma.appSettings.updateMany({
      data: {
        lowStockAlertEmails: "buyer@example.com",
        lowStockAlertHour: 0,
        emailAccentColor: "#7a3e1d",
        emailFooter: "Linden Row, Main Street",
      },
    });
    await prisma.emailWording.create({
      data: { key: "low-stock", subject: "Reorder: {items}", intro: "Time to order." },
    });
    invalidateAppSettingsCache();
    expect(await queueLowStockAlert(new Date("2026-11-06T12:00:00Z"))).toBe(1);
    const email = await prisma.emailQueue.findFirstOrThrow({ where: { templateKey: "low-stock" } });
    expect(email.subject).toBe("Reorder: 1 item");
    expect(email.html).toContain("Time to order.");
    expect(email.html).toContain("#7a3e1d");
    expect(email.html).toContain("Linden Row, Main Street");
    expect(email.html).toContain("Oak side table");
  });

  it("the morning email comes out in the store's words, with nothing to say still saying nothing", async () => {
    await prisma.appSettings.updateMany({ data: { followUpEmailHour: 0 } });
    await prisma.emailWording.create({
      data: { key: "follow-up", intro: "Morning {name}, from {store}." },
    });
    invalidateAppSettingsCache();
    const result = await queueFollowUpEmails(new Date("2026-11-06T12:00:00Z"));
    expect(result).toMatchObject({ queued: 0 });
    expect(await prisma.emailQueue.count()).toBe(0);
  });
});

describe("the screen", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  }

  it("opens for someone who may change settings, with what's saved", async () => {
    await prisma.appSettings.updateMany({
      data: { emailAccentColor: "#7a3e1d", logoUrl: "/l.png" },
    });
    await prisma.emailWording.create({ data: { key: "invoice", closing: "Mine" } });
    invalidateAppSettingsCache();
    signIn("owner");
    const page = await EmailLookPage();
    expect(page.props.initialLook.accent).toBe("#7a3e1d");
    expect(page.props.hasLogo).toBe(true);
    expect(page.props.initialWordings.invoice.closing).toBe("Mine");
  });

  it("starts from the default colour, and no one else gets in", async () => {
    await makeStaff("pat", "DESIGNER");
    signIn("owner");
    const page = await EmailLookPage();
    expect(page.props.initialLook.accent).toBe("#1c1f2e");
    expect(page.props.hasLogo).toBe(false);
    signIn("pat");
    await expect(EmailLookPage()).rejects.toThrow(/REDIRECT/);
  });
});
