// /app/__tests__/integration/smsProvider.integration.test.ts
//
// GAP-12: texts, through a provider chosen in Settings (Twilio first), to
// customers who agreed to them, with a STOP honored.
//
// Before: no provider existed, so a text meant staff pasting a link into their
// own phone, and the automatic customer messages could only go by email.
//
// Real routes and database. Twilio itself is a stand-in at the one place Holt
// reaches it, `fetch`, answering as its docs say it does: that checks what Holt
// sends and how it treats the answers, not that Twilio accepts them. Nothing here
// has been sent through a real Twilio account.

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
import { invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { assignOrderToRun } from "@/lib/deliveryService";
import { testIntegration } from "@/lib/integrationTest";
import { queueDueMessages, OPTED_OUT, NO_EMAIL } from "@/lib/messages/due";
import type { MessageKind } from "@/lib/messages/catalog";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { runDateOf } from "@/lib/messages/timing";
import { NO_TEXTABLE_NUMBER, NO_TEXT_CONSENT, REPLIED_STOP } from "@/lib/sms/consent";
import { deliverQueuedSms, enqueueSms, processSmsQueue } from "@/lib/sms/queue";
import { twilioSignature } from "@/lib/sms/twilio";
import { verifyPortalToken } from "@/lib/portalToken";
import { handler as listSettings } from "@/pages/api/customer-messages/index";
import { handler as saveSetting } from "@/pages/api/customer-messages/[kind]";
import { handler as orderMessagesRoute } from "@/pages/api/sales/orders/[id]/messages";
import { handlers as customerRoute } from "@/pages/api/customers/[id]/index";
import customersRoute from "@/pages/api/customers/index";
import textLinkRoute, { handler as textLink } from "@/pages/api/portal/text-link";
import webhookRoute from "@/pages/api/sms/twilio/webhook";
import emailQueueRoute from "@/pages/api/automations/email-queue";

const sessionMock = getServerSession as jest.Mock;
const staff = { user: { id: "st", email: "staff@example.com" } } as unknown as Session;
const AUTH_TOKEN = "twilio-test-token";
const PHONE = "+16875551817";
const WEBHOOK_URL = "https://holt.example.com/api/sms/twilio/webhook";

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
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as TestRes;
}

function request(
  method: string,
  query: Record<string, string>,
  body?: unknown,
  headers: Record<string, string> = {},
  url?: string,
) {
  return { method, query, body, cookies: {}, headers, url } as unknown as NextApiRequest;
}

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;

async function call(
  handler: Handler,
  method: string,
  query: Record<string, string>,
  body?: unknown,
) {
  const res = makeRes();
  await handler(request(method, query, body), res, staff);
  return res;
}

/** What the stand-in for Twilio was sent, and what it answers next. */
const twilio = {
  sent: [] as { url: string; auth: string | null; form: URLSearchParams }[],
  answer: () =>
    Response.json({ sid: `SM${twilio.sent.length}`, status: "queued" }, { status: 201 }),
};

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_MESSAGING_SERVICE_SID",
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setUpTwilio() {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_FROM_NUMBER = "+15550001111";
}

async function sale(customerData: Record<string, unknown> = {}) {
  const customer = await prisma.customer.create({
    data: {
      firstName: "Jordan",
      lastName: "Ames",
      email: "jordan@example.com",
      phone: "(687) 555-1817",
      smsConsentAt: new Date(),
      smsConsentBy: "staff@example.com",
      ...customerData,
    },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `SO-${customer.id}`,
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      deliveryMethod: "DELIVERY",
    },
  });
  return { customer, order };
}

let vehicleId: number;

/** Put the sale's delivery on a run, which is what sends "your delivery is scheduled". */
async function schedule(
  salesOrderId: number,
  day = addDays(businessDayKey(new Date(), "America/New_York"), 3),
) {
  const run = await prisma.deliveryRun.create({
    data: { runNumber: `RUN-${salesOrderId}`, runDate: runDateOf(day), vehicleId },
  });
  await prisma.$transaction((tx) =>
    assignOrderToRun(tx, { salesOrderId, runId: run.id, runDate: run.runDate, createdBy: "d" }),
  );
}

async function settingBody(kind: MessageKind, patch: Record<string, unknown> = {}) {
  const list = await call(listSettings as Handler, "GET", {});
  const row = list.body.find((s: { kind: string }) => s.kind === kind);
  const { isActive, subject, body, includeOrderLink, offsetDays, sendHour, linkUrl } = row;
  const { channel, textBody, textIncludeOrderLink } = row;
  return {
    isActive,
    subject,
    body,
    includeOrderLink,
    offsetDays,
    sendHour,
    linkUrl,
    channel,
    textBody,
    textIncludeOrderLink,
    ...patch,
  };
}

async function switchOn(patch: Record<string, unknown>, kind: MessageKind = "DELIVERY_SCHEDULED") {
  const res = await call(
    saveSetting,
    "PUT",
    { kind },
    await settingBody(kind, { isActive: true, ...patch }),
  );
  expect(res.statusCode).toBe(200);
}

/** A webhook as Twilio would send it, signed unless told otherwise. */
async function webhook(params: Record<string, string>, signature?: string) {
  const res = makeRes();
  const header = signature ?? twilioSignature(AUTH_TOKEN, WEBHOOK_URL, params);
  await webhookRoute(
    request("POST", {}, params, { "x-twilio-signature": header }, "/api/sms/twilio/webhook"),
    res,
  );
  return res;
}

beforeAll(() => {
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    twilio.sent.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      form: new URLSearchParams(String(init?.body ?? "")),
    });
    return twilio.answer();
  });
});

beforeEach(async () => {
  await resetTestDb();
  invalidateAppSettingsCache();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  twilio.sent = [];
  twilio.answer = () =>
    Response.json({ sid: `SM${twilio.sent.length}`, status: "queued" }, { status: 201 });
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEXTAUTH_URL = "https://holt.example.com";
  process.env.NEXTAUTH_SECRET = "sms-test-secret";
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  vehicleId = (await prisma.vehicle.create({ data: { name: "Truck" } })).id;
});

afterAll(async () => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await prisma.$disconnect();
});

const queued = () => prisma.smsQueue.findMany({ orderBy: { id: "asc" } });

describe("sending through Twilio", () => {
  it("posts the form Twilio's API takes, with its credentials, and keeps its id", async () => {
    setUpTwilio();
    const id = await enqueueSms({ to: PHONE, body: "Hello" });
    expect(await deliverQueuedSms(id)).toBe("SENT");
    expect(twilio.sent).toHaveLength(1);
    const [req] = twilio.sent;
    expect(req.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    expect(req.auth).toBe(`Basic ${Buffer.from(`ACtest:${AUTH_TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(req.form)).toEqual({
      To: PHONE,
      Body: "Hello",
      From: "+15550001111",
      StatusCallback: WEBHOOK_URL,
    });
    const [row] = await queued();
    expect(row).toMatchObject({ status: "SENT", attempts: 1, providerMessageId: "SM1" });
    expect(row.sentAt).not.toBeNull();
    // Accepted isn't delivered.
    expect(row.deliveredAt).toBeNull();
  });

  it("uses a Messaging Service when one is set, and asks for no reports it couldn't receive", async () => {
    setUpTwilio();
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest";
    process.env.NEXTAUTH_URL = "http://localhost:3000";
    await deliverQueuedSms(await enqueueSms({ to: PHONE, body: "Hello" }));
    expect(Object.fromEntries(twilio.sent[0].form)).toEqual({
      To: PHONE,
      Body: "Hello",
      MessagingServiceSid: "MGtest",
    });
  });

  it("leaves texts queued, and calls nobody, until a provider is set up", async () => {
    await enqueueSms({ to: PHONE, body: "Hello" });
    expect(await processSmsQueue()).toMatchObject({ processed: 0, skipped: 1 });
    expect(twilio.sent).toHaveLength(0);
    expect((await queued())[0].status).toBe("PENDING");

    setUpTwilio();
    expect(await processSmsQueue()).toMatchObject({ processed: 1, sent: 1 });
    expect((await queued())[0].status).toBe("SENT");
  });

  it("retries an outage, then gives up", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 20500, message: "Internal" }, { status: 500 });
    await enqueueSms({ to: PHONE, body: "Hello" });
    for (let i = 1; i <= 3; i++) {
      await processSmsQueue();
      expect((await queued())[0]).toMatchObject({ status: "PENDING", attempts: i });
    }
    await processSmsQueue();
    const [row] = await queued();
    expect(row).toMatchObject({ status: "FAILED", attempts: 4 });
    expect(row.lastError).toContain("20500");
    // A failed row isn't tried again.
    await processSmsQueue();
    expect(twilio.sent).toHaveLength(4);
  });

  it("retries when told to slow down, and when Twilio can't be reached", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 20429, message: "Too many" }, { status: 429 });
    await enqueueSms({ to: PHONE, body: "Hello" });
    await processSmsQueue();
    expect((await queued())[0].status).toBe("PENDING");
    twilio.answer = () => {
      throw new Error("connect ETIMEDOUT");
    };
    await processSmsQueue();
    const [row] = await queued();
    expect(row).toMatchObject({ status: "PENDING", attempts: 2 });
    expect(row.lastError).toContain("ETIMEDOUT");
  });

  it("keeps trying through a rotated auth token: the new one may come in time", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 20003, message: "Auth" }, { status: 401 });
    await enqueueSms({ to: PHONE, body: "Hello" });
    await processSmsQueue();
    expect((await queued())[0]).toMatchObject({ status: "PENDING", attempts: 1 });
    twilio.answer = () => Response.json({ sid: "SMnew" }, { status: 201 });
    await processSmsQueue();
    expect((await queued())[0]).toMatchObject({ status: "SENT", providerMessageId: "SMnew" });
  });

  it("doesn't retry what can't change, such as a bad number", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 21211, message: "Invalid 'To'" }, { status: 400 });
    await enqueueSms({ to: PHONE, body: "Hello" });
    await processSmsQueue();
    const [row] = await queued();
    expect(row).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(row.lastError).toContain("21211");
    expect(await prisma.smsOptOut.count()).toBe(0);
  });

  it("records a STOP Twilio tells it about when it refuses a send", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 21610, message: "Unsubscribed" }, { status: 400 });
    await enqueueSms({ to: PHONE, body: "Hello" });
    await processSmsQueue();
    expect((await queued())[0].status).toBe("FAILED");
    expect(await prisma.smsOptOut.findUnique({ where: { phone: PHONE } })).toMatchObject({
      source: "PROVIDER",
    });
  });

  it("doesn't send a queued text to a number that replied STOP since", async () => {
    setUpTwilio();
    await enqueueSms({ to: PHONE, body: "Hello" });
    await prisma.smsOptOut.create({ data: { phone: PHONE, source: "REPLY" } });
    await processSmsQueue();
    expect(twilio.sent).toHaveLength(0);
    expect((await queued())[0]).toMatchObject({ status: "FAILED", lastError: REPLIED_STOP });
  });

  it("the database refuses a number that isn't E.164", async () => {
    await expect(enqueueSms({ to: "687-555-1817", body: "Hello" })).rejects.toThrow();
    await expect(
      prisma.smsOptOut.create({ data: { phone: "6875551817", source: "REPLY" } }),
    ).rejects.toThrow();
  });
});

describe("Settings › Integrations", () => {
  it("proves the credentials with a call that sends nothing", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ friendly_name: "Our Store", status: "active" });
    expect(await testIntegration("twilio")).toMatchObject({ ok: true, level: "verified" });
    expect(twilio.sent[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest.json");
  });

  it("says when they're wrong, missing, or the account is suspended", async () => {
    expect((await testIntegration("twilio")).ok).toBe(false);
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 20003 }, { status: 401 });
    expect(await testIntegration("twilio")).toMatchObject({ ok: false });
    twilio.answer = () => Response.json({ status: "suspended" });
    const result = await testIntegration("twilio");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("suspended");
  });
});

describe("Twilio's webhook", () => {
  beforeEach(setUpTwilio);

  it("changes nothing without a good signature", async () => {
    const stop = { From: PHONE, Body: "STOP" };
    expect((await webhook(stop, "not-the-signature")).statusCode).toBe(403);
    // Signed with the wrong token, and for the wrong URL.
    expect((await webhook(stop, twilioSignature("other", WEBHOOK_URL, stop))).statusCode).toBe(403);
    expect(
      (await webhook(stop, twilioSignature(AUTH_TOKEN, "https://elsewhere.example.com/x", stop)))
        .statusCode,
    ).toBe(403);
    // Signed for other parameters.
    expect(
      (
        await webhook(
          stop,
          twilioSignature(AUTH_TOKEN, WEBHOOK_URL, { From: PHONE, Body: "START" }),
        )
      ).statusCode,
    ).toBe(403);
    expect(await prisma.smsOptOut.count()).toBe(0);
  });

  it("refuses everything when no auth token is set up (fails closed)", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const stop = { From: PHONE, Body: "STOP" };
    expect((await webhook(stop, twilioSignature("", WEBHOOK_URL, stop))).statusCode).toBe(403);
    expect(await prisma.smsOptOut.count()).toBe(0);
  });

  it("records a STOP, keeps it through a repeat, and lifts it on START", async () => {
    const res = await webhook({ From: PHONE, Body: "stop" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<Response></Response>");
    expect(await prisma.smsOptOut.findUnique({ where: { phone: PHONE } })).toMatchObject({
      source: "REPLY",
    });
    expect((await webhook({ From: PHONE, Body: "STOP" })).statusCode).toBe(200);
    expect(await prisma.smsOptOut.count()).toBe(1);
    await webhook({ From: PHONE, Body: "START" });
    expect(await prisma.smsOptOut.count()).toBe(0);
  });

  it("ignores an ordinary reply", async () => {
    expect((await webhook({ From: PHONE, Body: "What time?" })).statusCode).toBe(200);
    expect(await prisma.smsOptOut.count()).toBe(0);
  });

  it("records that a text arrived", async () => {
    await deliverQueuedSms(await enqueueSms({ to: PHONE, body: "Hello" }));
    await webhook({ MessageSid: "SM1", MessageStatus: "delivered" });
    const [row] = await queued();
    expect(row.status).toBe("SENT");
    expect(row.deliveredAt).not.toBeNull();
  });

  it("records that carriers blocked a text the provider had accepted", async () => {
    // What an unregistered US number looks like: accepted, then error 30034.
    await deliverQueuedSms(await enqueueSms({ to: PHONE, body: "Hello" }));
    expect((await queued())[0].status).toBe("SENT");
    await webhook({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30034" });
    const [row] = await queued();
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("30034");
  });

  it("answers a report about a text it doesn't know", async () => {
    expect((await webhook({ MessageSid: "SMnope", MessageStatus: "delivered" })).statusCode).toBe(
      200,
    );
  });
});

describe("the customer's agreement", () => {
  it("records who ticked it and when, keeps that through re-ticking, and clears it when unticked", async () => {
    const { customer } = await sale({ smsConsentAt: null, smsConsentBy: null });
    const put = (body: unknown) =>
      call(customerRoute.PUT as Handler, "PUT", { id: String(customer.id) }, body);

    const on = await put({ textConsent: true });
    expect(on.statusCode).toBe(200);
    expect(on.body.smsConsentBy).toBe("staff@example.com");
    const at = on.body.smsConsentAt;
    expect(at).not.toBeNull();

    const again = await call(
      customerRoute.PUT as Handler,
      "PUT",
      { id: String(customer.id) },
      { textConsent: true },
    );
    expect(again.body.smsConsentAt).toEqual(at);

    // A save that doesn't send it leaves it.
    const other = await put({ firstName: "Jo" });
    expect(other.body.smsConsentAt).toEqual(at);

    const off = await put({ textConsent: false });
    expect(off.body).toMatchObject({ smsConsentAt: null, smsConsentBy: null });
    expect((await put({ textConsent: "yes" })).statusCode).toBe(400);
  });

  it("takes it on a new customer", async () => {
    await prisma.user.create({ data: { id: "adm", email: "adm@example.com" } });
    await syncBuiltInRoles({ prisma });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    await prisma.staffMember.create({
      data: {
        userId: "adm",
        email: "adm@example.com",
        displayName: "A",
        role: "ADMIN",
        roleId: role.id,
      },
    });
    sessionMock.mockResolvedValue({ user: { id: "adm", email: "adm@example.com" } });
    const res = makeRes();
    await customersRoute(request("POST", {}, { firstName: "New", textConsent: true }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.smsConsentBy).toBe("adm@example.com");
    const without = makeRes();
    await customersRoute(request("POST", {}, { firstName: "Other" }), without);
    expect(without.body.smsConsentAt).toBeNull();
  });

  it("keeps how they'd rather hear from the store", async () => {
    const { customer } = await sale();
    const put = (body: unknown) =>
      call(customerRoute.PUT as Handler, "PUT", { id: String(customer.id) }, body);
    expect((await put({ preferredChannel: "TEXT" })).body.preferredChannel).toBe("TEXT");
    expect((await put({ preferredChannel: "" })).body.preferredChannel).toBeNull();
    expect((await put({ preferredChannel: "PIGEON" })).statusCode).toBe(400);
  });

  it("shows whether the number replied STOP, on the customer's record", async () => {
    const { customer } = await sale();
    const session = { user: { id: "nobody", email: "x@example.com" } } as unknown as Session;
    const res = makeRes();
    await customerRoute.GET(request("GET", { id: String(customer.id) }), res, session);
    expect(res.body).toMatchObject({ textableNumber: PHONE, smsOptedOutAt: null });
    await prisma.smsOptOut.create({ data: { phone: PHONE, source: "REPLY" } });
    const after = makeRes();
    await customerRoute.GET(request("GET", { id: String(customer.id) }), after, session);
    expect(after.body.smsOptedOutAt).not.toBeNull();
  });
});

describe("automatic messages by text", () => {
  it("won't switch a message to text until texting is set up", async () => {
    const res = await call(
      saveSetting,
      "PUT",
      { kind: "DELIVERY_SCHEDULED" },
      await settingBody("DELIVERY_SCHEDULED", { isActive: true, channel: "TEXT" }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Integrations/);
    // Off, it can be got ready ahead of time.
    const off = await call(
      saveSetting,
      "PUT",
      { kind: "DELIVERY_SCHEDULED" },
      await settingBody("DELIVERY_SCHEDULED", { isActive: false, channel: "TEXT" }),
    );
    expect(off.statusCode).toBe(200);
  });

  it("gives a message saved before texts the suggested wording", async () => {
    setUpTwilio();
    await settingBody("DELIVERY_SCHEDULED");
    await prisma.customerMessageSetting.update({
      where: { kind: "DELIVERY_SCHEDULED" },
      data: { textBody: null },
    });
    await switchOn({ channel: "TEXT" });
    const { order } = await sale();
    await schedule(order.id);
    await queueDueMessages();
    expect((await queued())[0].body).toContain(
      `your delivery of order ${order.orderno} is scheduled`,
    );
  });

  it("stays email until the store changes it", async () => {
    setUpTwilio();
    await switchOn({});
    const { order } = await sale();
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.emailQueue.count()).toBe(1);
    expect(await prisma.smsQueue.count()).toBe(0);
  });

  it("goes by text in the store's wording, with a fresh link and how to opt out", async () => {
    setUpTwilio();
    await switchOn({
      channel: "TEXT",
      textBody: "{store}: {customer}, order {order} is on {when}.",
    });
    const { order, customer } = await sale();
    await schedule(order.id);
    const summary = await queueDueMessages();
    expect(summary.DELIVERY_SCHEDULED).toEqual({ queued: 1, skipped: 0, failed: 0 });
    expect(await prisma.emailQueue.count()).toBe(0);
    const [row] = await queued();
    expect(row.toPhone).toBe(PHONE);
    expect(row.body).toContain(`Holt: Jordan, order ${order.orderno} is on `);
    expect(row.body).toContain("Reply STOP to opt out.");
    expect(row.templateKey).toBe("customer-message-delivery-scheduled");
    const token = /portal\/order\?token=(\S+)/.exec(row.body)?.[1];
    expect(token && verifyPortalToken(token)).toEqual({
      orderId: order.id,
      customerId: customer.id,
    });
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "QUEUED",
      toPhone: PHONE,
      smsQueueId: row.id,
      toAddress: null,
      emailQueueId: null,
    });
    // Once per event.
    await queueDueMessages();
    expect(await prisma.smsQueue.count()).toBe(1);
  });

  it("leaves the link out of the text when the store says so", async () => {
    setUpTwilio();
    await switchOn({ channel: "TEXT", textIncludeOrderLink: false });
    const { order } = await sale();
    await schedule(order.id);
    await queueDueMessages();
    expect((await queued())[0].body).not.toContain("portal/order");
  });

  it("sends both when the store says both", async () => {
    setUpTwilio();
    await switchOn({ channel: "BOTH" });
    const { order } = await sale();
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.emailQueue.count()).toBe(1);
    expect(await prisma.smsQueue.count()).toBe(1);
  });

  it("follows the customer when the store says to, and is email for one with no preference", async () => {
    setUpTwilio();
    await switchOn({ channel: "CUSTOMER" });
    const text = await sale({ preferredChannel: "TEXT", email: "t@example.com" });
    const none = await sale({ email: "n@example.com", phone: null });
    await schedule(text.order.id);
    await schedule(none.order.id);
    await queueDueMessages();
    expect((await prisma.emailQueue.findMany()).map((e) => e.toAddress)).toEqual(["n@example.com"]);
    expect(await prisma.smsQueue.count()).toBe(1);
  });

  it.each([
    ["no agreement on record", { smsConsentAt: null }, NO_TEXT_CONSENT],
    ["no phone", { phone: null }, NO_TEXTABLE_NUMBER],
    ["a desk phone", { phone: "687 555 1817 x12" }, NO_TEXTABLE_NUMBER],
  ])("texts nobody with %s, and says why", async (_name, customerData, reason) => {
    setUpTwilio();
    await switchOn({ channel: "TEXT" });
    const { order } = await sale(customerData);
    await schedule(order.id);
    const summary = await queueDueMessages();
    expect(summary.DELIVERY_SCHEDULED).toEqual({ queued: 0, skipped: 1, failed: 0 });
    expect(await prisma.smsQueue.count()).toBe(0);
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "SKIPPED",
      smsSkipReason: reason,
    });
  });

  it("texts nobody whose number replied STOP, whichever record it's on", async () => {
    setUpTwilio();
    await switchOn({ channel: "TEXT" });
    await prisma.smsOptOut.create({ data: { phone: PHONE, source: "REPLY" } });
    const { order } = await sale({ phone: "687-555-1817" });
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.smsQueue.count()).toBe(0);
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "SKIPPED",
      smsSkipReason: REPLIED_STOP,
    });
  });

  it("still sends the email when only the text can't go, and says why the text didn't", async () => {
    setUpTwilio();
    await switchOn({ channel: "BOTH" });
    const { order } = await sale({ smsConsentAt: null });
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.emailQueue.count()).toBe(1);
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "QUEUED",
      smsSkipReason: NO_TEXT_CONSENT,
    });
  });

  it("still sends the text when only the email can't go", async () => {
    setUpTwilio();
    await switchOn({ channel: "BOTH" });
    const { order } = await sale({ email: null });
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.smsQueue.count()).toBe(1);
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "QUEUED",
      skipReason: NO_EMAIL,
    });
  });

  it("sends neither to a customer who asked for no automatic messages", async () => {
    setUpTwilio();
    await switchOn({ channel: "BOTH" });
    const { order } = await sale({ autoMessagesOptOut: true });
    await schedule(order.id);
    await queueDueMessages();
    expect(await prisma.emailQueue.count()).toBe(0);
    expect(await prisma.smsQueue.count()).toBe(0);
    expect(await prisma.customerMessage.findFirst()).toMatchObject({
      status: "SKIPPED",
      skipReason: OPTED_OUT,
    });
  });

  it("the cron sends the texts it queues", async () => {
    setUpTwilio();
    process.env.AUTO_IMPORT_API_KEY = "test-key";
    await switchOn({ channel: "TEXT" });
    const { order } = await sale();
    await schedule(order.id);
    const res = makeRes();
    await emailQueueRoute(
      request("POST", {}, undefined, { authorization: "Bearer test-key" }),
      res,
    );
    delete process.env.AUTO_IMPORT_API_KEY;
    expect(res.statusCode).toBe(200);
    expect(res.body.messages.DELIVERY_SCHEDULED.queued).toBe(1);
    expect(res.body.texts).toMatchObject({ processed: 1, sent: 1 });
    expect(twilio.sent).toHaveLength(1);
  });

  it("the order page shows where each text stands", async () => {
    setUpTwilio();
    await switchOn({ channel: "BOTH" });
    const good = await sale();
    const stopped = await sale({
      smsConsentAt: null,
      email: "s@example.com",
      phone: "687 555 1818",
    });
    await schedule(good.order.id);
    await schedule(stopped.order.id);
    await queueDueMessages();
    const texted = await call(orderMessagesRoute as Handler, "GET", { id: String(good.order.id) });
    expect(texted.body[0].text).toEqual({
      toPhone: PHONE,
      status: "PENDING",
      sentAt: null,
      deliveredAt: null,
      skipReason: null,
    });
    await processSmsQueue();
    await webhook({ MessageSid: "SM1", MessageStatus: "delivered" });
    const after = await call(orderMessagesRoute as Handler, "GET", { id: String(good.order.id) });
    expect(after.body[0].text.status).toBe("SENT");
    expect(after.body[0].text.deliveredAt).not.toBeNull();
    const skipped = await call(orderMessagesRoute as Handler, "GET", {
      id: String(stopped.order.id),
    });
    expect(skipped.body[0].text).toMatchObject({ toPhone: null, skipReason: NO_TEXT_CONSENT });
  });
});

describe("Text the link, from the order page", () => {
  const send = (orderId: unknown) => call(textLink, "POST", {}, { orderId });

  it("texts the customer's link now, says it went, and lists it on the order", async () => {
    setUpTwilio();
    const { order, customer } = await sale();
    const res = await send(order.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "SENT", to: PHONE });
    const body = twilio.sent[0].form.get("Body") ?? "";
    expect(body).toContain(`here's your order ${order.orderno}.`);
    expect(body).toContain("Reply STOP to opt out.");
    const token = /portal\/order\?token=(\S+)/.exec(body)?.[1];
    expect(token && verifyPortalToken(token)).toEqual({
      orderId: order.id,
      customerId: customer.id,
    });
    const history = await call(orderMessagesRoute as Handler, "GET", { id: String(order.id) });
    expect(history.body[0]).toMatchObject({ label: "Order link, sent by staff" });
    expect(history.body[0].text.status).toBe("SENT");
  });

  it("can send it twice", async () => {
    setUpTwilio();
    const { order } = await sale();
    await send(order.id);
    expect((await send(order.id)).statusCode).toBe(200);
    expect(twilio.sent).toHaveLength(2);
  });

  it("goes to a customer who asked for no automatic messages: staff chose to send this one", async () => {
    setUpTwilio();
    const { order } = await sale({ autoMessagesOptOut: true });
    expect((await send(order.id)).statusCode).toBe(200);
  });

  it("holds to who may get a text", async () => {
    setUpTwilio();
    const noConsent = await send((await sale({ smsConsentAt: null })).order.id);
    expect([noConsent.statusCode, noConsent.body.error]).toEqual([409, NO_TEXT_CONSENT]);
    await prisma.smsOptOut.create({ data: { phone: PHONE, source: "REPLY" } });
    const stopped = await send((await sale({ email: "other@example.com" })).order.id);
    expect([stopped.statusCode, stopped.body.error]).toEqual([409, REPLIED_STOP]);
    expect(twilio.sent).toHaveLength(0);
    expect(await prisma.smsQueue.count()).toBe(0);
  });

  it("says so when texting isn't set up", async () => {
    const res = await send((await sale()).order.id);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/Integrations/);
    expect(await prisma.smsQueue.count()).toBe(0);
  });

  it("says when it couldn't be sent, without the provider's words", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 21211, message: "Invalid 'To'" }, { status: 400 });
    const res = await send((await sale()).order.id);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).not.toContain("21211");
    expect(res.body.error).toContain("Admin › Email");
  });

  it("says when it's queued for later", async () => {
    setUpTwilio();
    twilio.answer = () => Response.json({ code: 20500, message: "Internal" }, { status: 500 });
    const res = await send((await sale()).order.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("PENDING");
  });

  it("refuses a bad request, and anyone who can't write sales", async () => {
    setUpTwilio();
    expect((await send("7")).statusCode).toBe(400);
    expect((await send(99999)).statusCode).toBe(404);
    const noCustomer = await prisma.salesOrder.create({
      data: { orderno: "SO-none", status: "ORDER", orderDate: new Date() },
    });
    expect((await send(noCustomer.id)).statusCode).toBe(400);

    await syncBuiltInRoles({ prisma });
    for (const key of ["ADMIN", "WAREHOUSE", "DESIGNER"] as const) {
      const email = `${key.toLowerCase()}@example.com`;
      await prisma.user.create({ data: { id: key, email } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.staffMember.create({
        data: { userId: key, email, displayName: key, role: key, roleId: role.id },
      });
    }
    const { order } = await sale();
    const asRole = async (key: string) => {
      sessionMock.mockResolvedValue({
        user: { id: key, email: `${key.toLowerCase()}@example.com` },
      });
      const res = makeRes();
      await textLinkRoute(request("POST", {}, { orderId: order.id }), res);
      return res.statusCode;
    };
    expect(await asRole("WAREHOUSE")).toBe(403);
    expect(await asRole("DESIGNER")).toBe(200);
  });
});
