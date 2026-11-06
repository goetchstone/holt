// __tests__/integration/automations.integration.test.ts
//
// GAP-37: what a store sets decides what runs. Real routes, jobs and database; only the
// session readers are mocked. A job is made to fail by replacing its entry in the job
// list, since nothing outside this list can run.

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
jest.mock("@/lib/opsAlert", () => ({ reportOpsAlert: jest.fn().mockResolvedValue(undefined) }));

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
import { reportOpsAlert } from "@/lib/opsAlert";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { AUTOMATION_CATALOG, AUTOMATION_KEYS } from "@/lib/automations/catalog";
import { AUTOMATION_JOBS } from "@/lib/automations/jobs";
import { runDueAutomations } from "@/lib/automations/runner";
import { loadAutomationsScreen } from "@/lib/automations/screen";
import { getAutomationSettings, saveAutomationSetting } from "@/lib/automations/settings";
import tickRoute from "@/pages/api/automations/tick";
import keyRoute from "@/pages/api/admin/automations/[key]";
import reconciliationRoute from "@/pages/api/automations/daily-reconciliation";
import levelRoute from "@/pages/api/automations/customer-level-recalc";
import housekeepingRoute from "@/pages/api/automations/lead-housekeeping";
import mailchimpRoute from "@/pages/api/automations/mailchimp-sync";
import AutomationsPage from "@/app/(dashboard)/app/admin/automations/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const savedEnv = { ...process.env };

async function call(
  route: Route,
  who: string | null,
  {
    method = "POST",
    query = {},
    body = {},
    authorization,
  }: {
    method?: string;
    query?: Record<string, string | undefined>;
    body?: object;
    authorization?: string;
  } = {},
) {
  const session = who ? { user: { id: who, email: `${who}@example.com` } } : null;
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
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    {
      method,
      query,
      body,
      cookies: {},
      headers: authorization ? { authorization } : {},
    } as unknown as NextApiRequest,
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

async function setting(key: string) {
  return prisma.automationSetting.findUniqueOrThrow({ where: { key } });
}

/** Switch everything off, so a test sees only what it switched on. */
async function allOff() {
  await getAutomationSettings();
  await prisma.automationSetting.updateMany({ data: { isActive: false } });
}

async function onAndDue(key: string) {
  await prisma.automationSetting.update({
    where: { key },
    data: {
      isActive: true,
      activeSince: new Date("2026-01-01T00:00:00Z"),
      lastStartedAt: null,
      lastStatus: null,
    },
  });
}

const NOW = new Date("2026-11-06T18:00:00Z");

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
      timezone: "America/New_York",
    },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  // Permissions are bypassed while no active admin exists, so one always does here.
  await makeStaff("owner", "ADMIN");
  (reportOpsAlert as jest.Mock).mockClear();
});

afterEach(() => {
  process.env = { ...savedEnv };
  jest.restoreAllMocks();
});

describe("what a store starts with", () => {
  it("has a row for every automation, as the catalog says, in its order", async () => {
    const rows = await getAutomationSettings();
    expect(rows.map((r) => r.key)).toEqual([...AUTOMATION_KEYS]);
    for (const row of rows) {
      const info = AUTOMATION_CATALOG[row.key];
      expect(row.isActive).toBe(info.startsOn);
      expect(row.frequency).toBe(info.schedule.frequency);
      expect(row.hour).toBe(info.schedule.hour);
      expect(row.activeSince !== null).toBe(info.startsOn);
    }
  });

  it("leaves a store's own choices alone when it reads them again", async () => {
    await getAutomationSettings();
    await prisma.automationSetting.update({
      where: { key: "send-queue" },
      data: { isActive: false },
    });
    const rows = await getAutomationSettings();
    expect(rows.find((r) => r.key === "send-queue")?.isActive).toBe(false);
  });

  it("doesn't run anything just because it was just created", async () => {
    const results = await runDueAutomations(new Date());
    // Every few minutes is measured from when it was switched on, and the rest wait for
    // their next scheduled moment.
    expect(results).toEqual([]);
  });
});

describe("what a store sets", () => {
  it("saves whether it runs and when, and who changed it", async () => {
    const saved = await call(keyRoute, "owner", {
      method: "PUT",
      query: { key: "customer-levels" },
      body: { isActive: true, frequency: "WEEKLY", hour: 3, weekday: 2, everyMinutes: 5 },
    });
    expect(saved.status).toBe(200);
    const row = await setting("customer-levels");
    expect(row).toMatchObject({ frequency: "WEEKLY", hour: 3, weekday: 2, everyMinutes: null });
    expect(row.updatedBy).toBe("owner@example.com");
  });

  it("refuses a schedule that doesn't work, saying why, and changes nothing", async () => {
    await getAutomationSettings();
    const before = await setting("reconciliation");
    const bad = await call(keyRoute, "owner", {
      method: "PUT",
      query: { key: "reconciliation" },
      body: { isActive: true, frequency: "DAILY", hour: 30 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/hour/);
    expect((await setting("reconciliation")).hour).toBe(before.hour);
  });

  it("refuses a frequency that job can't do, and the screen doesn't offer it", async () => {
    const bad = await call(keyRoute, "owner", {
      method: "PUT",
      query: { key: "reconciliation" },
      body: { isActive: true, frequency: "WEEKLY", hour: 3, weekday: 2 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/How often/);
  });

  it("refuses without saying on or off", async () => {
    const bad = await call(keyRoute, "owner", {
      method: "PUT",
      query: { key: "reconciliation" },
      body: { frequency: "HOURLY" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/On or off/);
  });

  it("answers 404 for something that isn't an automation", async () => {
    const put = await call(keyRoute, "owner", { method: "PUT", query: { key: "nope" } });
    expect(put.status).toBe(404);
    const post = await call(keyRoute, "owner", { method: "POST", query: { key: "nope" } });
    expect(post.status).toBe(404);
  });

  it("stamps when it was switched on, and leaves that alone otherwise", async () => {
    await getAutomationSettings();
    const body = { isActive: true, frequency: "DAILY", hour: 5 };
    expect((await setting("lead-housekeeping")).activeSince).toBeNull();

    await saveAutomationSetting(prisma, "lead-housekeeping", body, "x");
    const switchedOn = (await setting("lead-housekeeping")).activeSince;
    expect(switchedOn).not.toBeNull();

    await saveAutomationSetting(prisma, "lead-housekeeping", { ...body, hour: 6 }, "x");
    expect((await setting("lead-housekeeping")).activeSince).toEqual(switchedOn);
  });

  it("is only for those who may run scheduled jobs", async () => {
    await makeStaff("pat", "DESIGNER");
    const put = await call(keyRoute, "pat", {
      method: "PUT",
      query: { key: "send-queue" },
      body: { isActive: false, frequency: "HOURLY" },
    });
    expect(put.status).toBe(403);
    const post = await call(keyRoute, "pat", { method: "POST", query: { key: "send-queue" } });
    expect(post.status).toBe(403);
  });

  it("the database won't hold a schedule that makes no sense", async () => {
    await getAutomationSettings();
    await expect(
      prisma.automationSetting.update({
        where: { key: "send-queue" },
        data: { frequency: "DAILY", everyMinutes: null, hour: 40 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.automationSetting.update({
        where: { key: "send-queue" },
        data: { lastStatus: "WHATEVER" },
      }),
    ).rejects.toThrow();
  });
});

describe("waking up", () => {
  it("runs what's on and due, for real, and records how it went", async () => {
    await allOff();
    await onAndDue("quote-holds");
    const results = await runDueAutomations(NOW);
    expect(results).toEqual([
      { key: "quote-holds", status: "OK", summary: "0 quotes released stock." },
    ]);
    const row = await setting("quote-holds");
    expect(row.lastStatus).toBe("OK");
    expect(row.lastStartedAt).toEqual(NOW);
    expect(row.lastFinishedAt).not.toBeNull();
    expect(row.lastSummary).toBe("0 quotes released stock.");
  });

  it("leaves alone what a store switched off, however overdue", async () => {
    await allOff();
    const spy = jest.spyOn(AUTOMATION_JOBS["quote-holds"], "run");
    await prisma.automationSetting.update({
      where: { key: "quote-holds" },
      data: { activeSince: new Date("2026-01-01T00:00:00Z") },
    });
    expect(await runDueAutomations(NOW)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves alone what's on but not due", async () => {
    await allOff();
    await onAndDue("reconciliation");
    await prisma.automationSetting.update({
      where: { key: "reconciliation" },
      data: { lastStartedAt: NOW },
    });
    const spy = jest.spyOn(AUTOMATION_JOBS.reconciliation, "run");
    expect(await runDueAutomations(new Date(NOW.getTime() + 60_000))).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("goes by the hour the store chose", async () => {
    await allOff();
    await onAndDue("ar-drift");
    await saveAutomationSetting(
      prisma,
      "ar-drift",
      { isActive: true, frequency: "DAILY", hour: 15 },
      "x",
    );
    await prisma.automationSetting.update({
      where: { key: "ar-drift" },
      data: { lastStartedAt: new Date("2026-11-06T18:00:00Z") },
    });
    const spy = jest.spyOn(AUTOMATION_JOBS["ar-drift"], "run").mockResolvedValue({
      ok: true,
      summary: "ran",
    });
    // 3pm in New York on Nov 6 is 20:00 UTC.
    expect(await runDueAutomations(new Date("2026-11-06T19:59:00Z"))).toEqual([]);
    expect(await runDueAutomations(new Date("2026-11-06T20:00:00Z"))).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("doesn't run it again on the next wake-up", async () => {
    await allOff();
    await onAndDue("quote-holds");
    await runDueAutomations(NOW);
    expect(await runDueAutomations(new Date(NOW.getTime() + 5 * 60_000))).toEqual([]);
  });

  it("records being woken, even with nothing to do", async () => {
    await allOff();
    await runDueAutomations(NOW);
    const app = await prisma.appSettings.findFirstOrThrow();
    expect(app.automationsWokenAt).toEqual(NOW);
  });

  it("carries on with the others after one fails, and says so", async () => {
    await allOff();
    await onAndDue("quote-holds");
    await onAndDue("stale-payments");
    jest.spyOn(AUTOMATION_JOBS["quote-holds"], "run").mockRejectedValue(new Error("it broke"));
    const results = await runDueAutomations(NOW);
    expect(results.map((r) => [r.key, r.status])).toEqual([
      ["quote-holds", "FAILED"],
      ["stale-payments", "OK"],
    ]);
    const row = await setting("quote-holds");
    expect(row.lastStatus).toBe("FAILED");
    expect(row.lastSummary).toBe("it broke");
    expect(row.lastFinishedAt).not.toBeNull();
    // logError raises its own alert the first time it sees an error. This one is every time.
    const titles = (reportOpsAlert as jest.Mock).mock.calls.map(([alert]) => alert.title);
    expect(titles).toContain("Automation failed: Release expired quote holds");
    expect(titles.join()).not.toMatch(/Clear abandoned/);
  });

  it("treats a job's own bad result as a failure too", async () => {
    await allOff();
    await onAndDue("quote-holds");
    jest
      .spyOn(AUTOMATION_JOBS["quote-holds"], "run")
      .mockResolvedValue({ ok: false, summary: "it couldn't" });
    const [result] = await runDueAutomations(NOW);
    expect(result).toMatchObject({ status: "FAILED", summary: "it couldn't" });
    expect(reportOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("doesn't alert when all's well", async () => {
    await allOff();
    await onAndDue("quote-holds");
    await runDueAutomations(NOW);
    expect(reportOpsAlert).not.toHaveBeenCalled();
  });

  it("skips what isn't set up yet, says why, and tries again next time", async () => {
    await allOff();
    await onAndDue("mailchimp-sync");
    delete process.env.MAILCHIMP_API_KEY;
    const run = jest.spyOn(AUTOMATION_JOBS["mailchimp-sync"], "run");
    const [result] = await runDueAutomations(NOW);
    expect(result.status).toBe("SKIPPED");
    expect(result.summary).toMatch(/isn't set up/);
    expect(run).not.toHaveBeenCalled();
    expect(reportOpsAlert).not.toHaveBeenCalled();
    expect((await setting("mailchimp-sync")).lastStatus).toBe("SKIPPED");
  });

  it("keeps a long summary to a sensible length", async () => {
    await allOff();
    await onAndDue("quote-holds");
    jest
      .spyOn(AUTOMATION_JOBS["quote-holds"], "run")
      .mockResolvedValue({ ok: true, summary: "x".repeat(2000) });
    await runDueAutomations(NOW);
    expect((await setting("quote-holds")).lastSummary).toHaveLength(500);
  });
});

describe("a job that's already running", () => {
  async function running(startedAt: Date) {
    await allOff();
    await onAndDue("quote-holds");
    await prisma.automationSetting.update({
      where: { key: "quote-holds" },
      data: { lastStatus: "RUNNING", lastStartedAt: startedAt },
    });
  }

  it("isn't started again by a wake-up", async () => {
    // Its hour has turned over, so it's due, but the last run is still going.
    await running(new Date(NOW.getTime() - 60 * 60_000));
    const spy = jest.spyOn(AUTOMATION_JOBS["quote-holds"], "run");
    const results = await runDueAutomations(NOW);
    expect(results).toEqual([{ key: "quote-holds", status: "ALREADY_RUNNING", summary: null }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("isn't started again by Run now, which says so", async () => {
    await running(new Date());
    const post = await call(keyRoute, "owner", { query: { key: "quote-holds" } });
    expect(post.status).toBe(409);
    expect(post.body.error).toMatch(/already running/);
  });

  it("is taken to have died after two hours, so it can't block forever", async () => {
    await running(new Date(NOW.getTime() - 2 * 60 * 60_000 - 1000));
    const [result] = await runDueAutomations(NOW);
    expect(result.status).toBe("OK");
  });

  it("only one of two wake-ups at once gets to run it", async () => {
    await allOff();
    await onAndDue("quote-holds");
    let runs = 0;
    jest.spyOn(AUTOMATION_JOBS["quote-holds"], "run").mockImplementation(async () => {
      runs += 1;
      return { ok: true, summary: "ran" };
    });
    await Promise.all([runDueAutomations(NOW), runDueAutomations(NOW)]);
    expect(runs).toBe(1);
  });
});

describe("Run now", () => {
  it("runs one that's switched off, and answers what it did", async () => {
    await allOff();
    const post = await call(keyRoute, "owner", { query: { key: "quote-holds" } });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({
      key: "quote-holds",
      isActive: false,
      lastStatus: "OK",
      lastSummary: "0 quotes released stock.",
    });
  });

  it("only takes the two methods it has", async () => {
    const got = await call(keyRoute, "owner", { method: "GET", query: { key: "quote-holds" } });
    expect(got.status).toBe(405);
  });

  it("answers what went wrong without its internals when it isn't a known problem", async () => {
    await getAutomationSettings();
    jest
      .spyOn(prisma.automationSetting, "update")
      .mockRejectedValueOnce(new Error("secret db text"));
    const bad = await call(keyRoute, "owner", {
      method: "PUT",
      query: { key: "quote-holds" },
      body: { isActive: true, frequency: "HOURLY" },
    });
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toMatch(/secret db text/);
  });
});

describe("the wake-up route", () => {
  beforeEach(() => {
    process.env.AUTO_IMPORT_API_KEY = "the-scheduler-key";
  });

  it("takes the scheduler's key", async () => {
    await allOff();
    const tick = await call(tickRoute, null, { authorization: "Bearer the-scheduler-key" });
    expect(tick.status).toBe(200);
    expect(tick.body).toEqual({ results: [] });
  });

  it("refuses a wrong key", async () => {
    const tick = await call(tickRoute, null, { authorization: "Bearer nope" });
    expect(tick.status).toBe(401);
    const app = await prisma.appSettings.findFirstOrThrow();
    expect(app.automationsWokenAt).toBeNull();
  });

  it("only takes a POST", async () => {
    const tick = await call(tickRoute, null, {
      method: "GET",
      authorization: "Bearer the-scheduler-key",
    });
    expect(tick.status).toBe(405);
  });

  it("answers 200 even when a job failed: that's reported elsewhere", async () => {
    await allOff();
    await onAndDue("quote-holds");
    jest.spyOn(AUTOMATION_JOBS["quote-holds"], "run").mockRejectedValue(new Error("it broke"));
    const tick = await call(tickRoute, null, { authorization: "Bearer the-scheduler-key" });
    expect(tick.status).toBe(200);
    expect(tick.body.results[0].status).toBe("FAILED");
  });
});

describe("every job, run for real on an empty store", () => {
  // None needs an outside system set up, except those it says aren't ready.
  beforeEach(() => {
    for (const key of ["MAILCHIMP_API_KEY", "AXPER_API_KEY", "SMTP_HOST"]) delete process.env[key];
    process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-0000";
  });

  it.each([
    ["send-queue", /0 emails sent, 0 failed\. 0 texts sent\./],
    ["quote-holds", /0 quotes released stock\./],
    ["stale-payments", /0 payments closed\./],
    // A day with no journal entry isn't balanced, so an empty store shows drift. Not a failure.
    ["reconciliation", /0 days balanced, 1 with drift, 0 failed\./],
    // With no POS import set up, it says so itself.
    ["source-import", /./],
    ["ar-drift", /0 customers checked, 0 off\./],
    ["customer-levels", /0 customers updated\./],
    ["lead-housekeeping", /0 leads archived\./],
  ])("%s", async (key, summary) => {
    await getAutomationSettings();
    const post = await call(keyRoute, "owner", { query: { key } });
    expect(post.status).toBe(200);
    expect(post.body.lastStatus).toBe("OK");
    expect(post.body.lastSummary).toMatch(summary);
  });

  it.each([["traffic"], ["mailchimp-sync"], ["mailchimp-customers"]])(
    "%s says it isn't set up",
    async (key) => {
      await getAutomationSettings();
      const post = await call(keyRoute, "owner", { query: { key } });
      expect(post.status).toBe(200);
      expect(post.body.lastStatus).toBe("SKIPPED");
      expect(post.body.lastSummary.length).toBeGreaterThan(10);
    },
  );

  it("reconciliation writes its log row for yesterday, in the store's time zone", async () => {
    await getAutomationSettings();
    await call(keyRoute, "owner", { query: { key: "reconciliation" } });
    const logs = await prisma.dailyReconciliationLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].createdBy).toBe("automations");
    const app = await prisma.appSettings.findFirstOrThrow();
    const today = businessDayKey(new Date(), app.timezone);
    expect(logs[0].date.toISOString().slice(0, 10)).toBe(addDays(today, -1));
  });
});

describe("the routes still answer as they did", () => {
  beforeEach(() => {
    process.env.AUTO_IMPORT_API_KEY = "the-scheduler-key";
  });
  const key = { authorization: "Bearer the-scheduler-key" };

  it("reconciliation runs one day, or the range it's given", async () => {
    const one = await call(reconciliationRoute, null, {
      ...key,
      body: { date: "2026-11-01" },
    });
    expect(one.status).toBe(200);
    expect(one.body.daysReconciled).toBe(1);
    expect(one.body.results[0].date).toBe("2026-11-01");
    const range = await call(reconciliationRoute, null, {
      ...key,
      body: { start: "2026-11-01", end: "2026-11-03" },
    });
    expect(range.body.daysReconciled).toBe(3);
    expect(await prisma.dailyReconciliationLog.count()).toBe(4);
  });

  it("reconciliation names who ran it", async () => {
    await call(reconciliationRoute, "owner", { body: { date: "2026-11-01" } });
    const log = await prisma.dailyReconciliationLog.findFirstOrThrow();
    expect(log.createdBy).toBe("owner@example.com");
  });

  it("customer levels logs its run", async () => {
    const run = await call(levelRoute, null, key);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ status: "SUCCESS", customersUpdated: 0, errors: [] });
    const log = await prisma.mailchimpSyncLog.findFirstOrThrow({
      where: { kind: "customer-level-recalc" },
    });
    expect(log.id).toBe(run.body.logId);
  });

  it("lead housekeeping logs its run", async () => {
    const run = await call(housekeepingRoute, null, key);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ status: "SUCCESS", leadsArchived: 0, errors: [] });
    expect(await prisma.mailchimpSyncLog.count({ where: { kind: "lead-housekeeping" } })).toBe(1);
  });

  it("the Mailchimp sync refuses a phase it doesn't have", async () => {
    const bad = await call(mailchimpRoute, null, { ...key, query: { phase: "nope" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/phase must be one of/);
  });

  it("the Mailchimp sync reports a failed run as one, and logs it", async () => {
    delete process.env.MAILCHIMP_API_KEY;
    const run = await call(mailchimpRoute, null, { ...key, query: { phase: "campaigns" } });
    expect(run.status).toBe(500);
    expect(run.body.status).toBe("FAILED");
    expect(run.body.errors[0]).toMatch(/campaigns/);
    expect(
      await prisma.mailchimpSyncLog.count({ where: { kind: "mailchimp-sync:campaigns" } }),
    ).toBe(1);
  });
});

describe("the screen", () => {
  function signIn(who: string) {
    (getToken as jest.Mock).mockResolvedValue({ id: who });
    (headers as jest.Mock).mockResolvedValue(new Headers());
    (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  }

  it("opens for someone who may run scheduled jobs, and no one else", async () => {
    await makeStaff("pat", "DESIGNER");
    signIn("owner");
    const page = await AutomationsPage();
    expect(page.props.rows).toHaveLength(AUTOMATION_KEYS.length);
    signIn("pat");
    await expect(AutomationsPage()).rejects.toThrow(/REDIRECT/);
  });

  it("says when nothing is waking Holt, and stops saying so once something does", async () => {
    let screen = await loadAutomationsScreen(NOW);
    expect(screen.wokenAt).toBeNull();
    expect(screen.wokenLate).toBe(true);

    await allOff();
    await runDueAutomations(NOW);
    screen = await loadAutomationsScreen(new Date(NOW.getTime() + 5 * 60_000));
    expect(screen.wokenAt).toEqual(NOW);
    expect(screen.wokenLate).toBe(false);

    screen = await loadAutomationsScreen(new Date(NOW.getTime() + 16 * 60_000));
    expect(screen.wokenLate).toBe(true);
  });

  it("says what isn't ready, and nothing about what is", async () => {
    delete process.env.MAILCHIMP_API_KEY;
    const { notReady } = await loadAutomationsScreen(NOW);
    expect(notReady["mailchimp-sync"]).toMatch(/isn't set up/);
    expect(notReady["quote-holds"]).toBeUndefined();
    expect(notReady["send-queue"]).toBeUndefined();
  });

  it("still opens when it can't tell whether one is ready", async () => {
    jest
      .spyOn(AUTOMATION_JOBS.traffic, "notReady" as never)
      .mockRejectedValue(new Error("no idea") as never);
    const { notReady } = await loadAutomationsScreen(NOW);
    expect(notReady.traffic).toMatch(/couldn't tell/);
  });

  it("lists the messages with settings of their own, as they're set", async () => {
    await prisma.appSettings.updateMany({ data: { followUpEmailHour: 8 } });
    invalidateAppSettingsCache();
    const { messages } = await loadAutomationsScreen(NOW);
    expect(messages).toEqual([
      {
        name: "Morning follow-up email",
        state: "Every morning at 8 AM",
        href: "/app/admin/settings#follow-ups",
      },
      { name: "Low stock list", state: "Off", href: "/app/admin/settings#low-stock-alert" },
      {
        name: "Customer messages",
        state: "0 of 4 on",
        href: "/app/admin/setup/customer-messages",
      },
    ]);
  });
});
