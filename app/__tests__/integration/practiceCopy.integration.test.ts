// __tests__/integration/practiceCopy.integration.test.ts
//
// What a practice copy refuses to do, against the real routes and database (GAP-28).
// Only DATABASE_URL's value changes: the test client stays connected to fbc_test_db,
// so a test can store a credential and then watch a practice copy ignore it. Saving
// and starting over create and drop databases, so they run for real in
// prisma/testing/practiceCopyDrill.ts instead (rule 59).

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));

const mockSendMail = jest.fn().mockResolvedValue({});
jest.mock("nodemailer", () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail })) },
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { Children, isValidElement, type ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { resolveCredential, setCredential } from "@/lib/integrationCredentials";
import { getSmtpConfig } from "@/lib/email/config";
import { sendEmail } from "@/lib/email/sender";
import { twilioProvider } from "@/lib/sms/twilio";
import { getStripe } from "@/lib/stripe";
import { reportOpsAlert } from "@/lib/opsAlert";
import integrationsRoute from "@/pages/api/admin/settings/integrations";
import practiceRoute from "@/pages/api/admin/database/practice";
import { handler as createProject } from "@/pages/api/google/create-project";
import sendPaymentLink from "@/pages/api/stripe/send-payment-link";
import IntegrationsPage from "@/app/(dashboard)/app/admin/settings/integrations/page";
import DatabasePage from "@/app/(dashboard)/app/admin/setup/database/page";
import { IntegrationsView } from "@/app/(dashboard)/app/admin/settings/integrations/IntegrationsView";
import { PracticeCopyCard } from "@/app/(dashboard)/app/admin/setup/database/PracticeCopyCard";
import { DatabaseBackupView } from "@/app/(dashboard)/app/admin/setup/database/DatabaseBackupView";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-0000";
const savedEnv = { ...process.env };

function asPractice(): void {
  process.env.DATABASE_URL = (savedEnv.DATABASE_URL as string).replace(
    /\/([^/?]+)(\?|$)/,
    "/$1_practice$2",
  );
}

function fakeResponse() {
  const seen: { status: number; body?: Body } = { status: 200 };
  const res = {
    status(code: number) {
      seen.status = code;
      return this;
    },
    json(value: Body) {
      seen.body = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return { seen, res: res as unknown as NextApiResponse };
}

async function call(route: Route, who: string, method: string, body: object = {}) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: who, email: `${who}@example.com` },
  });
  const { seen, res } = fakeResponse();
  await route(
    { method, query: {}, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res,
  );
  return seen;
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
  // Permissions are bypassed while no active admin exists, so one always does here.
  await makeStaff("owner", "ADMIN");
  mockSendMail.mockClear();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("credentials", () => {
  it("a stored key works on a normal copy and is ignored on a practice one", async () => {
    await setCredential(DEFAULT_ORG_ID, "stripe", "secretKey", "sk_test_stored_here");
    expect(await resolveCredential("stripe", "secretKey", "UNSET_ENV")).toBe("sk_test_stored_here");
    asPractice();
    expect(await resolveCredential("stripe", "secretKey", "UNSET_ENV")).toBeUndefined();
  });

  it("an env key copied from the live deployment is ignored too", async () => {
    process.env.SOME_LIVE_KEY = "from-the-live-env";
    expect(await resolveCredential("stripe", "secretKey", "SOME_LIVE_KEY")).toBe(
      "from-the-live-env",
    );
    asPractice();
    expect(await resolveCredential("stripe", "secretKey", "SOME_LIVE_KEY")).toBeUndefined();
  });
});

describe("email", () => {
  beforeEach(() => {
    process.env.SMTP_HOST = "smtp.live.example.com";
    process.env.EMAIL_FROM = "store@example.com";
  });

  it("sends on a normal copy", async () => {
    expect(await getSmtpConfig()).not.toBeNull();
    const sent = await sendEmail({ to: "a@example.com", subject: "s", html: "h" });
    expect(sent.ok).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing on a practice copy, and says it skipped", async () => {
    asPractice();
    const sent = await sendEmail({ to: "a@example.com", subject: "s", html: "h" });
    expect(sent).toEqual({ ok: false, skipped: true });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

describe("texts", () => {
  it("are not configured on a practice copy, and nothing is called", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC_live";
    process.env.TWILIO_AUTH_TOKEN = "live-token";
    process.env.TWILIO_FROM_NUMBER = "+15555550100";
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    expect(await twilioProvider.isConfigured()).toBe(true);
    asPractice();
    expect(await twilioProvider.isConfigured()).toBe(false);
    const result = await twilioProvider.send({ to: "+15555550101", body: "hello" });
    expect(result).toEqual({ outcome: "not-configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Stripe", () => {
  it("has no client on a practice copy", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_from_live_env";
    await expect(getStripe()).resolves.toBeDefined();
    asPractice();
    await expect(getStripe()).rejects.toThrow(/not configured/);
  });
});

describe("payment links", () => {
  it("say why not on a practice copy", async () => {
    asPractice();
    const link = await call(sendPaymentLink, "owner", "POST", { orderId: 1 });
    expect(link.status).toBe(409);
    expect(link.body?.error).toMatch(/practice copy/);
  });

  it("carry on to the usual checks otherwise", async () => {
    const link = await call(sendPaymentLink, "owner", "POST", {});
    expect(link.status).toBe(400);
    expect(link.body?.error).toMatch(/orderId/);
  });
});

describe("ops alerts", () => {
  it("go to the webhook on a normal copy and only the log on a practice one", async () => {
    process.env.OPS_ALERT_WEBHOOK = "https://hooks.example.com/ops";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await reportOpsAlert({ title: "t", detail: "d" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();
    asPractice();
    await reportOpsAlert({ title: "t", detail: "d" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("Settings › Integrations", () => {
  it("takes a key on a normal copy", async () => {
    const put = await call(integrationsRoute, "owner", "PUT", {
      provider: "stripe",
      field: "secretKey",
      value: "sk_test_typed_in",
    });
    expect(put.status).toBe(200);
    expect(await prisma.integrationCredential.count()).toBe(1);
  });

  it("refuses one on a practice copy, saying why, and stores nothing", async () => {
    asPractice();
    const put = await call(integrationsRoute, "owner", "PUT", {
      provider: "stripe",
      field: "secretKey",
      value: "sk_test_real_looking_key",
    });
    expect(put.status).toBe(409);
    expect(put.body?.error).toMatch(/practice copy/);
    expect(await prisma.integrationCredential.count()).toBe(0);
  });
});

describe("the Google project folders", () => {
  it("refuses on a practice copy before touching Drive", async () => {
    asPractice();
    const { seen, res } = fakeResponse();
    await createProject(
      { method: "POST", body: { customerLastName: "Smith" } } as unknown as NextApiRequest,
      res,
      { accessToken: "a-google-token" } as never,
    );
    expect(seen.status).toBe(409);
    expect(seen.body?.error).toMatch(/practice copy/);
  });

  it("gets past that on a normal copy", async () => {
    const { seen, res } = fakeResponse();
    await createProject(
      { method: "POST", body: { customerLastName: "Smith" } } as unknown as NextApiRequest,
      res,
      { accessToken: "a-google-token" } as never,
    );
    // Not configured here, so it stops at the next check, short of Drive.
    expect(seen.status).toBe(503);
  });
});

function signInToPages(who: string): void {
  (getToken as jest.Mock).mockResolvedValue({ id: who });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
}

function allElements(node: ReactNode): React.ReactElement[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...allElements(child.props.children)]
      : [],
  );
}

describe("the screens", () => {
  it("Integrations shows its form normally, and says why not on a practice copy", async () => {
    signInToPages("owner");
    expect(allElements(await IntegrationsPage()).some((e) => e.type === IntegrationsView)).toBe(
      true,
    );
    asPractice();
    const practice = allElements(await IntegrationsPage());
    expect(practice.some((e) => e.type === IntegrationsView)).toBe(false);
    expect(JSON.stringify(practice[0].props)).toMatch(/practice copy/);
  });

  it("the database page offers Start over only on a practice copy", async () => {
    signInToPages("owner");
    expect(allElements(await DatabasePage()).some((e) => e.type === PracticeCopyCard)).toBe(false);
    asPractice();
    const card = allElements(await DatabasePage()).find((e) => e.type === PracticeCopyCard);
    expect(card).toBeDefined();
    // Nothing has been saved beside the test database.
    expect((card?.props as { savedOn: string | null }).savedOn).toBeNull();
  });

  it("and only to someone who may run it", async () => {
    const role = await prisma.role.create({ data: { key: "CONFIG_ONLY", name: "Config only" } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permission: "admin.config" } });
    await makeStaff("config-only", "DESIGNER");
    await prisma.staffMember.update({
      where: { userId: "config-only" },
      data: { roleId: role.id },
    });
    invalidateRoleGrantCache();
    signInToPages("config-only");
    asPractice();
    const page = allElements(await DatabasePage());
    expect(page.some((e) => e.type === DatabaseBackupView)).toBe(true);
    expect(page.some((e) => e.type === PracticeCopyCard)).toBe(false);
  });
});

describe("the practice route", () => {
  it("does nothing on a copy that isn't practice", async () => {
    const save = await call(practiceRoute, "owner", "POST", { action: "save" });
    expect(save.status).toBe(409);
    expect(save.body?.error).toMatch(/isn't a practice copy/);
    const startOver = await call(practiceRoute, "owner", "POST", { action: "start-over" });
    expect(startOver.status).toBe(409);
  });

  it("is only for those who may run destructive data operations", async () => {
    await makeStaff("designer", "DESIGNER");
    asPractice();
    const denied = await call(practiceRoute, "designer", "POST", { action: "save" });
    expect(denied.status).toBe(403);
  });

  it("asks for an action it knows", async () => {
    asPractice();
    const bad = await call(practiceRoute, "owner", "POST", { action: "wipe" });
    expect(bad.status).toBe(400);
  });

  it("only takes a POST", async () => {
    const got = await call(practiceRoute, "owner", "GET");
    expect(got.status).toBe(405);
  });
});
