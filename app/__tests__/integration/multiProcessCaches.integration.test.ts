// /app/__tests__/integration/multiProcessCaches.integration.test.ts
//
// Holt running as several app processes on one database (docs/HOSTING.md). Each
// test here stands a second "process" up beside the first with
// jest.isolateModules, which gives it its own copy of every module's state --
// its own caches, its own snapshot of the cache generations -- over the same
// database, which is exactly what a second container has. Each would fail
// against the code it replaced:
//
//   - a role revocation made through one process stops working in the other
//     within CACHE_GENERATION_CHECK_MS (before: up to the 30s TTL);
//   - the settings screen reads what is stored, not a process's copy, and a save
//     made from a stale page answers 409 instead of undoing a newer save (before:
//     silently written back);
//   - two drains of the email (and text) queue at once send each row once
//     (before: both sent every row), a screen's send-now leaves a row another
//     drain is sending alone, and a last try interrupted mid-send ends FAILED
//     rather than PENDING for ever. Only the transport is faked;
//   - a store renamed, added or deleted through one process is seen by the
//     import's location map in another within the bound (before: up to 5
//     minutes, in every process including the one that saved it);
//   - the import's Unknown Vendor and Uncategorized ids are re-resolved when
//     their rows are gone (before: a merge in another process left them
//     pointing at a deleted row until restart);
//   - two processes booting together both reconcile the built-in roles (before:
//     the loser of the create race threw P2002).

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

// The SMTP transport is the one thing faked: every send lands in one shared
// list, whichever module instance made it. A test may set __mpGate to hold the
// NEXT send (only that one) until it resolves, so another drain can be made to
// act while a send is under way.
jest.mock("nodemailer", () => {
  const g = globalThis as unknown as { __mpSent?: string[]; __mpGate?: Promise<void> };
  g.__mpSent ??= [];
  return {
    __esModule: true,
    default: {
      createTransport: () => ({
        sendMail: async (msg: { to: string }) => {
          const gate = g.__mpGate;
          g.__mpGate = undefined;
          if (gate) await gate;
          // Long enough that two drains are both mid-send at once.
          await new Promise((r) => setTimeout(r, 25));
          g.__mpSent!.push(msg.to);
          return { messageId: `m-${g.__mpSent!.length}` };
        },
      }),
    },
  };
});

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import * as resolverA from "@/lib/auth/permissionResolver";
import * as settingsA from "@/lib/appSettings";
import * as emailQueueA from "@/lib/email/queue";
import * as smsQueueA from "@/lib/sms/queue";
import * as emailConfig from "@/lib/email/config";
import * as smsConsent from "@/lib/sms/consent";
import { INTERRUPTED_SEND_ERROR, MAX_EMAIL_ATTEMPTS } from "@/lib/email/state";
import * as locationsA from "@/lib/storeLocationResolver";
import * as trafficA from "@/lib/trafficStoreMap";
import { CACHE_GENERATION_CHECK_MS } from "@/lib/cacheGeneration";
import { BUILT_IN_ROLES } from "@/lib/auth/permissionCatalog";
import { findProduct } from "@/lib/adapters/legacyPos/shared";
import roleByIdRoute from "@/pages/api/admin/roles/[id]";
import settingsRoute from "@/pages/api/admin/settings/index";
import locationsRoute from "@/pages/api/warehouse/locations/index";
import locationByIdRoute from "@/pages/api/warehouse/locations/[id]";

const sessionMock = getServerSession as jest.Mock;
const sent = () => (globalThis as unknown as { __mpSent: string[] }).__mpSent;

/** The same modules, loaded again with their own state: a second app process. */
function secondProcess() {
  let mods!: {
    resolver: typeof resolverA;
    settings: typeof settingsA;
    emailQueue: typeof emailQueueA;
    smsQueue: typeof smsQueueA;
    locations: typeof locationsA;
    traffic: typeof trafficA;
  };
  jest.isolateModules(() => {
    mods = {
      resolver: require("@/lib/auth/permissionResolver"),
      settings: require("@/lib/appSettings"),
      emailQueue: require("@/lib/email/queue"),
      smsQueue: require("@/lib/sms/queue"),
      locations: require("@/lib/storeLocationResolver"),
      traffic: require("@/lib/trafficStoreMap"),
    };
  });
  return mods;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `check` holds, polling the database. */
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}

/** True once a drain has claimed the row: its scheduledAt is the claim's lease. */
async function leased(model: "emailQueue" | "smsQueue", id: number): Promise<boolean> {
  const row =
    model === "emailQueue"
      ? await prisma.emailQueue.findUniqueOrThrow({ where: { id } })
      : await prisma.smsQueue.findUniqueOrThrow({ where: { id } });
  return row.scheduledAt.getTime() > Date.now() + 60_000;
}

/** Hold the next fake SMTP send until the returned function is called. */
function holdNextEmailSend(): () => void {
  let release!: () => void;
  (globalThis as unknown as { __mpGate?: Promise<void> }).__mpGate = new Promise<void>(
    (r) => (release = r),
  );
  return release;
}

function setUpSmtp() {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.EMAIL_FROM = "shop@example.com";
}

function setUpTwilio() {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
}
/** Past the bound a change has to cross processes within, with room for the query. */
const PAST_THE_BOUND = CACHE_GENERATION_CHECK_MS + 300;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
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
    end(payload?: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
  return res;
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

async function makeStaff(userId: string, enumRole: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId,
      displayName: userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: enumRole as any,
      roleId: role.id,
      isActive: true,
    },
  });
}

async function signInAsAdmin() {
  await makeStaff("admin-1", "ADMIN", "ADMIN");
  sessionMock.mockResolvedValue({ user: { id: "admin-1", email: "admin-1@example.com" } });
}

const savedEnv = { ...process.env };

beforeEach(async () => {
  await resetTestDb();
  resolverA.invalidateRoleGrantCache();
  settingsA.invalidateAppSettingsCache();
  sessionMock.mockReset();
  sent().length = 0;
  await prisma.organization.create({
    data: { id: settingsA.DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a role change made through one process", () => {
  it("stops a revoked permission working in another process within the bound", async () => {
    await syncBuiltInRoles({ prisma });
    const floor = await prisma.role.create({
      data: {
        key: "FLOOR",
        name: "Floor",
        isSystem: false,
        grantsAllPermissions: false,
        permissions: { create: [{ permission: "payment.refund" }] },
      },
    });
    await makeStaff("floor-1", "DESIGNER", "FLOOR");
    await signInAsAdmin();

    const b = secondProcess();
    const mayRefund = async () =>
      (
        await b.resolver.resolvePermissionAccess({
          userId: "floor-1",
          permission: "payment.refund",
          impersonate: null,
        })
      ).allowed;

    // Process B has loaded and cached the grant table.
    expect(await mayRefund()).toBe(true);

    // Process A takes the permission away, through the real route.
    const res = await call(roleByIdRoute, {
      method: "PUT",
      query: { id: String(floor.id) },
      body: { permissions: [] },
    });
    expect(res.statusCode).toBe(200);

    // Inside the 30s TTL, so only the shared generation can have ended B's copy.
    await sleep(PAST_THE_BOUND);
    expect(await mayRefund()).toBe(false);
  });
});

describe("settings across processes", () => {
  async function getSettings() {
    const res = await call(settingsRoute, { method: "GET" });
    expect(res.statusCode).toBe(200);
    return res.body as { settings: { tagline: string | null }; settingsVersion: string };
  }

  async function putSettings(body: Record<string, unknown>) {
    return call(settingsRoute, { method: "PUT", body });
  }

  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    await signInAsAdmin();
    await prisma.appSettings.create({
      data: { organizationId: settingsA.DEFAULT_ORG_ID, tagline: "Before" },
    });
  });

  it("shows what is stored, not this process's cached copy", async () => {
    // This process caches the settings...
    expect((await settingsA.getAppSettings()).tagline).toBe("Before");
    // ...then another process saves (its own bump does not reach this
    // process's snapshot for up to two seconds).
    await prisma.appSettings.update({
      where: { organizationId: settingsA.DEFAULT_ORG_ID },
      data: { tagline: "Saved elsewhere" },
    });
    expect((await getSettings()).settings.tagline).toBe("Saved elsewhere");
  });

  it("refuses a save made from a page loaded before someone else's save", async () => {
    const first = await getSettings();

    const save = await putSettings({ settingsVersion: first.settingsVersion, tagline: "One" });
    expect(save.statusCode).toBe(200);
    expect(save.body.settingsVersion).not.toBe(first.settingsVersion);

    // A second admin, still on the page as it was first loaded.
    const stale = await putSettings({ settingsVersion: first.settingsVersion, tagline: "Two" });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("SETTINGS_CHANGED");
    expect(stale.body.error).toMatch(/Reload the page/);
    const row = await prisma.appSettings.findUniqueOrThrow({
      where: { organizationId: settingsA.DEFAULT_ORG_ID },
    });
    expect(row.tagline).toBe("One");

    // Reloaded, the same change goes through.
    const again = await putSettings({ settingsVersion: save.body.settingsVersion, tagline: "Two" });
    expect(again.statusCode).toBe(200);
  });

  it("lets only one of two saves from the same page through", async () => {
    const { settingsVersion } = await getSettings();
    const results = await Promise.all([
      putSettings({ settingsVersion, tagline: "A" }),
      putSettings({ settingsVersion, tagline: "B" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it("is not refused by the automations tick writing the same row", async () => {
    const { settingsVersion } = await getSettings();
    // What runDueAutomations does every five minutes.
    await prisma.appSettings.updateMany({ data: { automationsWokenAt: new Date() } });
    const save = await putSettings({ settingsVersion, tagline: "Still fine" });
    expect(save.statusCode).toBe(200);
  });

  it("reaches another process's cached settings within the bound", async () => {
    const b = secondProcess();
    expect((await b.settings.getAppSettings()).tagline).toBe("Before");
    const { settingsVersion } = await getSettings();
    expect((await putSettings({ settingsVersion, tagline: "After" })).statusCode).toBe(200);
    await sleep(PAST_THE_BOUND);
    expect((await b.settings.getAppSettings()).tagline).toBe("After");
  });
});

describe("two drains of the queues at once", () => {
  it("send each email once", async () => {
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.EMAIL_FROM = "shop@example.com";
    for (const to of ["a@example.com", "b@example.com", "c@example.com"]) {
      await emailQueueA.enqueueEmail({ to, subject: "Hi", html: "<p>Hi</p>" });
    }
    const b = secondProcess();

    const [ra, rb] = await Promise.all([
      emailQueueA.processEmailQueue(),
      b.emailQueue.processEmailQueue(),
    ]);

    expect([...sent()].sort()).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(ra.sent + rb.sent).toBe(3);
    const rows = await prisma.emailQueue.findMany();
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ["SENT", 1],
      ["SENT", 1],
      ["SENT", 1],
    ]);
  });

  it("send each text once", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_FROM_NUMBER = "+15550001111";
    const posted: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
      await sleep(25);
      posted.push(new URLSearchParams(String(init?.body ?? "")).get("To") ?? "");
      return Response.json({ sid: `SM${posted.length}`, status: "queued" }, { status: 201 });
    });
    for (const to of ["+16875551811", "+16875551812"]) {
      await smsQueueA.enqueueSms({ to, body: "Hello" });
    }
    const b = secondProcess();

    await Promise.all([smsQueueA.processSmsQueue(), b.smsQueue.processSmsQueue()]);

    expect(posted.sort()).toEqual(["+16875551811", "+16875551812"]);
    const rows = await prisma.smsQueue.findMany();
    expect(rows.map((r) => r.status)).toEqual(["SENT", "SENT"]);
  });
});

// A screen's send-now reads the row after another drain has claimed it. The row
// then still reads PENDING, and the claim's compare-and-set would match what the
// screen read, so only isClaimedElsewhere stops a second send. The other drain
// is held mid-send to make that order certain rather than a matter of timing.
describe("a send-now while another drain is sending the row", () => {
  it("leaves the email alone, and it is sent once", async () => {
    setUpSmtp();
    const id = await emailQueueA.enqueueEmail({
      to: "po@example.com",
      subject: "PO",
      html: "<p>PO</p>",
    });
    const release = holdNextEmailSend();
    const b = secondProcess();
    const drain = b.emailQueue.processEmailQueue();
    await until(() => leased("emailQueue", id));

    expect(await emailQueueA.deliverQueuedEmail(id)).toBe("PENDING");
    expect(sent()).toEqual([]);

    release();
    expect((await drain).sent).toBe(1);
    expect(sent()).toEqual(["po@example.com"]);
    const row = await prisma.emailQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.attempts]).toEqual(["SENT", 1]);
  });

  it("leaves the text alone, and it is sent once", async () => {
    setUpTwilio();
    let release!: () => void;
    let gate: Promise<void> | undefined = new Promise<void>((r) => (release = r));
    const posted: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
      const held = gate;
      gate = undefined;
      if (held) await held;
      posted.push(new URLSearchParams(String(init?.body ?? "")).get("To") ?? "");
      return Response.json({ sid: `SM${posted.length}`, status: "queued" }, { status: 201 });
    });
    const id = await smsQueueA.enqueueSms({ to: "+16875551813", body: "Ready" });
    const b = secondProcess();
    const drain = b.smsQueue.processSmsQueue();
    await until(() => leased("smsQueue", id));

    expect(await smsQueueA.deliverQueuedSms(id)).toBe("PENDING");
    expect(posted).toEqual([]);

    release();
    expect((await drain).sent).toBe(1);
    expect(posted).toEqual(["+16875551813"]);
  });
});

// The claim counts the try before the send. A process that stops between the
// claim and writing the outcome -- a deploy, a crash, here a database error --
// has used that try. On the last one no drain would ever pick the row up again
// (they take attempts < MAX), so it sat PENDING for ever and never showed as
// failed.
describe("a send interrupted after its claim", () => {
  it("ends an email FAILED when that was its last try, once the lease runs out", async () => {
    setUpSmtp();
    const id = await emailQueueA.enqueueEmail({ to: "late@example.com", subject: "S", html: "x" });
    await prisma.emailQueue.update({
      where: { id },
      data: { attempts: MAX_EMAIL_ATTEMPTS - 1 },
    });
    jest.spyOn(emailConfig, "getSmtpConfig").mockRejectedValueOnce(new Error("connection lost"));
    await expect(emailQueueA.processEmailQueue()).rejects.toThrow("connection lost");

    // Claimed and never finished; while the lease runs, a drain leaves it be.
    await emailQueueA.processEmailQueue();
    let row = await prisma.emailQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.attempts]).toEqual(["PENDING", MAX_EMAIL_ATTEMPTS]);

    // The lease runs out.
    await prisma.emailQueue.update({
      where: { id },
      data: { scheduledAt: new Date(Date.now() - 1_000) },
    });
    await emailQueueA.processEmailQueue();
    row = await prisma.emailQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.lastError]).toEqual(["FAILED", INTERRUPTED_SEND_ERROR]);
    expect(sent()).toEqual([]);
  });

  it("retries an email whose interrupted try was not its last", async () => {
    setUpSmtp();
    const id = await emailQueueA.enqueueEmail({ to: "again@example.com", subject: "S", html: "x" });
    jest.spyOn(emailConfig, "getSmtpConfig").mockRejectedValueOnce(new Error("connection lost"));
    await expect(emailQueueA.processEmailQueue()).rejects.toThrow("connection lost");
    await prisma.emailQueue.update({
      where: { id },
      data: { scheduledAt: new Date(Date.now() - 1_000) },
    });

    await emailQueueA.processEmailQueue();
    const row = await prisma.emailQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.attempts]).toEqual(["SENT", 2]);
    expect(sent()).toEqual(["again@example.com"]);
  });

  it("ends a text FAILED when that was its last try, once the lease runs out", async () => {
    setUpTwilio();
    const fetchSpy = jest.spyOn(global, "fetch");
    const id = await smsQueueA.enqueueSms({ to: "+16875551814", body: "Late" });
    await prisma.smsQueue.update({ where: { id }, data: { attempts: MAX_EMAIL_ATTEMPTS - 1 } });
    jest.spyOn(smsConsent, "isSmsOptedOut").mockRejectedValueOnce(new Error("connection lost"));
    await expect(smsQueueA.processSmsQueue()).rejects.toThrow("connection lost");

    await smsQueueA.processSmsQueue();
    let row = await prisma.smsQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.attempts]).toEqual(["PENDING", MAX_EMAIL_ATTEMPTS]);

    await prisma.smsQueue.update({
      where: { id },
      data: { scheduledAt: new Date(Date.now() - 1_000) },
    });
    await smsQueueA.processSmsQueue();
    row = await prisma.smsQueue.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.lastError]).toEqual(["FAILED", INTERRUPTED_SEND_ERROR]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The import's location map keeps a store's names for 5 minutes and the traffic
// map for 60 seconds. A store edit bumped nothing, so every process -- the one
// that saved it included -- kept routing rows by the old names for that long.
describe("a store edit made through one process", () => {
  beforeEach(async () => {
    await syncBuiltInRoles({ prisma });
    await signInAsAdmin();
  });

  it("reaches another process's location map within the bound: rename, add, delete", async () => {
    const store = await prisma.storeLocation.create({
      data: { name: "Old Town", code: "OLD", type: "STORE", trafficSourceNames: ["Door 1"] },
    });
    const b = secondProcess();
    expect(await b.locations.resolveStoreLocationId("Old Town")).toBe(store.id);
    expect((await b.traffic.getTrafficStoreMap()).resolveDisplayName("Door 1")).toBe("Old Town");

    // Each change is checked on its own, so one write's bump cannot cover for
    // another that made none.
    const renamed = await call(locationByIdRoute, {
      method: "PUT",
      query: { id: String(store.id) },
      body: { name: "New Town", externalLocationName: "NT-01" },
    });
    expect(renamed.statusCode).toBe(200);
    await sleep(PAST_THE_BOUND);
    expect(await b.locations.resolveStoreLocationId("Old Town")).toBeNull();
    expect(await b.locations.resolveStoreLocationId("New Town")).toBe(store.id);
    expect(await b.locations.resolveStoreLocationId("NT-01")).toBe(store.id);
    expect((await b.traffic.getTrafficStoreMap()).resolveDisplayName("Door 1")).toBe("New Town");

    const added = await call(locationsRoute, {
      method: "POST",
      body: { name: "Harbor", code: "HBR", type: "STORE" },
    });
    expect(added.statusCode).toBe(201);
    await sleep(PAST_THE_BOUND);
    expect(await b.locations.resolveStoreLocationId("Harbor")).toBe(added.body.id);

    const deleted = await call(locationByIdRoute, {
      method: "DELETE",
      query: { id: String(added.body.id) },
    });
    expect(deleted.statusCode).toBe(200);
    await sleep(PAST_THE_BOUND);
    expect(await b.locations.resolveStoreLocationId("Harbor")).toBeNull();
  });
});

describe("the import's fallback rows", () => {
  it("are found again when the cached ones are gone (a merge in another process)", async () => {
    const first = await findProduct(prisma, { partNo: "X-1", autoCreate: true });
    const p1 = await prisma.product.findUniqueOrThrow({ where: { id: first!.id } });

    // Another process merges Unknown Vendor away, and someone tidies the
    // placeholder taxonomy: the rows this process cached are deleted.
    await prisma.product.delete({ where: { id: p1.id } });
    await prisma.vendor.delete({ where: { id: p1.vendorId } });
    await prisma.category.delete({ where: { id: p1.categoryId } });
    await prisma.department.delete({ where: { id: p1.departmentId } });

    const second = await findProduct(prisma, { partNo: "X-2", autoCreate: true });
    const p2 = await prisma.product.findUniqueOrThrow({
      where: { id: second!.id },
      include: { vendor: true, category: true },
    });
    expect(p2.vendorId).not.toBe(p1.vendorId);
    expect(p2.vendor.name).toBe("Unknown Vendor");
    expect(p2.categoryId).not.toBe(p1.categoryId);
    expect(p2.category.name).toBe("Uncategorized");
  });
});

describe("two processes booting together", () => {
  it("both reconcile the built-in roles", async () => {
    await Promise.all([syncBuiltInRoles({ prisma }), syncBuiltInRoles({ prisma })]);
    expect(await prisma.role.count()).toBe(BUILT_IN_ROLES.length);
  });
});
