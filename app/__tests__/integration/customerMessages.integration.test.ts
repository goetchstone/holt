// /app/__tests__/integration/customerMessages.integration.test.ts
//
// GAP-13: messages that send themselves (owner, 2026-11-03: each one on or off
// with the store's wording and timing, a fresh order link in each, a customer
// opt-out, the review invitation some days after handover; "All
// configurations").
//
// Before: nothing under purchasing, dispatch or delivery called the email
// queue, so a customer heard nothing unless someone wrote to them. Now the
// email-queue cron queues each message that is due (lib/messages/due.ts),
// once per event, and records the ones it chose not to send and why.
//
// Real routes and libraries, real database. Timed messages are scanned at a
// chosen instant (queueDueMessages(now)); the store's clock is America/
// New_York, the settings default.

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
import { receivePurchaseOrder } from "@/lib/purchasing/receivePurchaseOrder";
import { assignOrderToRun } from "@/lib/deliveryService";
import { verifyPortalToken } from "@/lib/portalToken";
import { addDays, businessDayKey, businessHourStart } from "@/lib/reports/businessDay";
import { runDateOf } from "@/lib/messages/timing";
import { LATE_LIMIT_DAYS, NO_EMAIL, OPTED_OUT, queueDueMessages } from "@/lib/messages/due";
import type { MessageKind } from "@/lib/messages/catalog";
import listRoute, { handler as listSettings } from "@/pages/api/customer-messages/index";
import saveRoute, { handler as saveSetting } from "@/pages/api/customer-messages/[kind]";
import orderMessagesDefault, {
  handler as orderMessagesRoute,
} from "@/pages/api/sales/orders/[id]/messages";
import emailQueueRoute from "@/pages/api/automations/email-queue";
import { handlers as customerRoute } from "@/pages/api/customers/[id]/index";

const TZ = "America/New_York";
const sessionMock = getServerSession as jest.Mock;
const admin = { user: { id: "adm", email: "admin@example.com" } } as unknown as Session;

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
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as TestRes;
}

type Handler = (req: NextApiRequest, res: NextApiResponse, session: Session) => unknown;

async function call(
  handler: Handler,
  method: string,
  query: Record<string, string>,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = makeRes();
  const req = { method, query, body, cookies: {}, headers } as unknown as NextApiRequest;
  await handler(req, res, admin);
  return res;
}

/** A kind's setting as the screen sends it: its suggested wording, with changes. */
async function settingBody(kind: MessageKind, patch: Record<string, unknown> = {}) {
  const list = await call(listSettings, "GET", {});
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

async function switchOn(kind: MessageKind, patch: Record<string, unknown> = {}) {
  const res = await call(
    saveSetting,
    "PUT",
    { kind },
    await settingBody(kind, { isActive: true, ...patch }),
  );
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** Start a message as if switched on long ago, for a scan at a chosen instant. */
async function onSince(kind: MessageKind, since: Date, patch: Record<string, unknown> = {}) {
  await switchOn(kind, patch);
  await prisma.customerMessageSetting.update({ where: { kind }, data: { activeSince: since } });
}

const LONG_AGO = new Date("2020-01-01T00:00:00Z");

async function world() {
  // The deployment's organization, which every queued email belongs to.
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } }); // id 1
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string, name: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const sofa = await product("SOFA", "Hartwell Sofa");
  const chair = await product("CHAIR", "Ellis Side Chair");
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const shelf = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "SHELF", name: "Shelf" },
  });
  await prisma.user.create({ data: { id: "rcv", email: "rcv@example.com" } });
  const vehicle = await prisma.vehicle.create({ data: { name: "Truck" } });
  let n = 0;

  async function order(opts: { email?: string | null; optOut?: boolean } = {}) {
    n += 1;
    const customer = await prisma.customer.create({
      data: {
        firstName: "Jordan",
        lastName: "Ames",
        email: opts.email === undefined ? `jordan${n}@example.com` : opts.email,
        autoMessagesOptOut: opts.optOut ?? false,
      },
    });
    const so = await prisma.salesOrder.create({
      data: {
        orderno: `SO-${n}`,
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocationId: store.id,
        deliveryMethod: "DELIVERY",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: sofa.id,
              productName: "Hartwell Sofa",
              orderedQuantity: 1,
              netPrice: 2000,
              cost: 900,
            },
            {
              lineNumber: 2,
              productId: chair.id,
              productName: "Ellis Side Chair",
              orderedQuantity: 2,
              netPrice: 400,
              cost: 150,
            },
          ],
        },
      },
      include: { lineItems: { orderBy: { lineNumber: "asc" } } },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-${n}`,
        vendorId: vendor.id,
        status: "CONFIRMED",
        lineItems: {
          create: so.lineItems.map((l) => ({
            productId: l.productId!,
            orderedQuantity: l.orderedQuantity,
            unitCost: 100,
            orderLineItemId: l.id,
          })),
        },
      },
      include: { lineItems: { orderBy: { id: "asc" } } },
    });
    return { customer, order: so, po };
  }

  type Sale = Awaited<ReturnType<typeof order>>;

  /** Receive line `i` of the sale's PO through the real receive. */
  async function receive(sale: Sale, i: number, quantity: number, condition?: string) {
    return prisma.$transaction((tx) =>
      receivePurchaseOrder(tx, {
        poId: sale.po.id,
        storeLocationId: store.id,
        receiverUserId: "rcv",
        actor: "rcv@example.com",
        items: [
          {
            purchaseOrderItemId: sale.po.lineItems[i].id,
            quantityReceived: quantity,
            destinationStockLocationId: shelf.id,
            ...(condition ? { condition } : {}),
          },
        ],
      }),
    );
  }

  /** Put the sale's delivery on a run for `day`, through the dispatch board's own path. */
  async function schedule(sale: Sale, day: string) {
    const run = await prisma.deliveryRun.create({
      data: {
        runNumber: `RUN-${sale.order.id}-${day}`,
        runDate: runDateOf(day),
        vehicleId: vehicle.id,
      },
    });
    return prisma.$transaction((tx) =>
      assignOrderToRun(tx, {
        salesOrderId: sale.order.id,
        runId: run.id,
        runDate: run.runDate,
        createdBy: "disp@example.com",
      }),
    );
  }

  return { order, receive, schedule, store, sofa, chair };
}

type World = Awaited<ReturnType<typeof world>>;
let w: World;

const emailsTo = (to: string) =>
  prisma.emailQueue.findMany({ where: { toAddress: to }, orderBy: { id: "asc" } });

// Each message signs a fresh portal link.
const savedSecret = process.env.NEXTAUTH_SECRET;
beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "customer-messages-test-secret";
});

beforeEach(async () => {
  await resetTestDb();
  sessionMock.mockReset();
  invalidateAppSettingsCache();
  w = await world();
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
  await prisma.$disconnect();
});

describe("Settings › Customer messages", () => {
  it("lists every message switched off, with its suggested wording, until the store sets it up", async () => {
    const res = await call(listSettings, "GET", {});
    expect(res.statusCode).toBe(200);
    expect(res.body.map((s: { kind: string }) => s.kind)).toEqual([
      "ARRIVED",
      "DELIVERY_SCHEDULED",
      "DELIVERY_REMINDER",
      "REVIEW_INVITE",
    ]);
    expect(res.body.every((s: { isActive: boolean }) => !s.isActive)).toBe(true);
    const reminder = res.body.find((s: { kind: string }) => s.kind === "DELIVERY_REMINDER");
    expect(reminder).toMatchObject({ offsetDays: 1, sendHour: 9, timing: "before-delivery" });
    expect(reminder.subject).toContain("{store}");
  });

  it("refuses wording a message can't fill, and names what it can use", async () => {
    const res = await call(
      saveSetting,
      "PUT",
      { kind: "ARRIVED" },
      await settingBody("ARRIVED", { body: "Your delivery is {when}" }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("{when}");
    expect(res.body.error).toContain("{pieces}");
  });

  it("refuses the review invitation switched on without a review page, or with a link that isn't https", async () => {
    const none = await call(
      saveSetting,
      "PUT",
      { kind: "REVIEW_INVITE" },
      await settingBody("REVIEW_INVITE", { isActive: true }),
    );
    expect(none.statusCode).toBe(400);
    expect(none.body.error).toMatch(/review page/);
    const plain = await call(
      saveSetting,
      "PUT",
      { kind: "REVIEW_INVITE" },
      await settingBody("REVIEW_INVITE", { isActive: true, linkUrl: "http://example.com/review" }),
    );
    expect(plain.statusCode).toBe(400);
    const timing = await call(
      saveSetting,
      "PUT",
      { kind: "REVIEW_INVITE" },
      await settingBody("REVIEW_INVITE", { offsetDays: 91 }),
    );
    expect(timing.statusCode).toBe(400);
    expect(timing.body.error).toMatch(/0 to 90/);
  });

  it("starts a message from the moment it is switched on, and keeps that moment through later edits", async () => {
    const before = Date.now();
    const on = await switchOn("ARRIVED");
    const since = new Date(on.activeSince).getTime();
    expect(since).toBeGreaterThanOrEqual(before);
    const edited = await call(
      saveSetting,
      "PUT",
      { kind: "ARRIVED" },
      await settingBody("ARRIVED", { subject: "It's here: {order}" }),
    );
    expect(edited.statusCode).toBe(200);
    expect(new Date(edited.body.activeSince).getTime()).toBe(since);
    await call(
      saveSetting,
      "PUT",
      { kind: "ARRIVED" },
      await settingBody("ARRIVED", { isActive: false }),
    );
    const again = await switchOn("ARRIVED");
    expect(new Date(again.activeSince).getTime()).toBeGreaterThan(since);
  });

  it("answers 404 for a message that doesn't exist", async () => {
    const res = await call(saveSetting, "PUT", { kind: "BIRTHDAY" }, {});
    expect(res.statusCode).toBe(404);
  });
});

describe("Your furniture has arrived", () => {
  it("sends nothing while the message is off, including after it was on", async () => {
    await switchOn("ARRIVED");
    await call(
      saveSetting,
      "PUT",
      { kind: "ARRIVED" },
      await settingBody("ARRIVED", { isActive: false }),
    );
    const sale = await w.order();
    await w.receive(sale, 0, 1);
    await queueDueMessages();
    expect(await prisma.customerMessage.count()).toBe(0);
    expect(await prisma.emailQueue.count()).toBe(0);
  });

  it("tells the customer what came in, once, with a fresh link to their order", async () => {
    await switchOn("ARRIVED");
    const sale = await w.order();
    await w.receive(sale, 0, 1);

    const summary = await queueDueMessages();
    expect(summary.ARRIVED).toEqual({ queued: 1, skipped: 0, failed: 0 });
    const [email] = await emailsTo(sale.customer.email!);
    expect(email.subject).toBe("Your order SO-1 has arrived");
    expect(email.html).toContain("Hi Jordan,");
    expect(email.html).toContain("Hartwell Sofa from your order SO-1");
    expect(email.html).not.toContain("Ellis Side Chair");
    const token = /portal\/order\?token=([^"&]+)/.exec(email.html)?.[1];
    expect(token && verifyPortalToken(decodeURIComponent(token))).toEqual({
      orderId: sale.order.id,
      customerId: sale.customer.id,
    });

    // A second run finds nothing new.
    await queueDueMessages();
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);

    // The chairs arriving later are their own message, about the chairs.
    await w.receive(sale, 1, 2);
    await queueDueMessages();
    const emails = await emailsTo(sale.customer.email!);
    expect(emails).toHaveLength(2);
    expect(emails[1].html).toContain("2 × Ellis Side Chair from your order");
    expect(emails[1].html).not.toContain("Hartwell Sofa");
    const recorded = await prisma.customerMessage.findMany({ orderBy: { id: "asc" } });
    expect(recorded.map((m) => m.status)).toEqual(["QUEUED", "QUEUED"]);
    expect(recorded[1].emailQueueId).toBe(emails[1].id);
  });

  it("announces nothing received before it was switched on, quarantined, imported, on a cancelled line, or already delivered", async () => {
    const early = await w.order();
    await w.receive(early, 0, 1);
    await switchOn("ARRIVED");

    const damaged = await w.order();
    await w.receive(damaged, 0, 1, "Damaged");

    const imported = await w.order();
    const r = await w.receive(imported, 0, 1);
    await prisma.receivingRecord.update({
      where: { id: r.receivingRecords[0].id },
      data: { externalGipNo: "G-1", externalPorNo: "P-1" },
    });

    const cancelled = await w.order();
    await prisma.orderLineItem.update({
      where: { id: cancelled.order.lineItems[0].id },
      data: { lineItemStatus: "CANCELLED" },
    });
    await w.receive(cancelled, 0, 1);

    const delivered = await w.order();
    await w.receive(delivered, 0, 1);
    await prisma.salesOrder.update({
      where: { id: delivered.order.id },
      data: { status: "FULFILLED", deliveredAt: new Date() },
    });

    // Recorded as put nothing on the books (a category that keeps no stock).
    const notStocked = await w.order();
    const ns = await w.receive(notStocked, 0, 1);
    await prisma.receivingRecord.update({
      where: { id: ns.receivingRecords[0].id },
      data: { intoStock: false },
    });

    const good = await w.order();
    await w.receive(good, 0, 1);

    await queueDueMessages();
    const sent = await prisma.customerMessage.findMany();
    expect(sent.map((m) => m.salesOrderId)).toEqual([good.order.id]);
  });

  it("doesn't announce an arrival more than a week late", async () => {
    await onSince("ARRIVED", LONG_AGO);
    const sale = await w.order();
    const r = await w.receive(sale, 0, 1);
    await prisma.receivingRecord.update({
      where: { id: r.receivingRecords[0].id },
      data: { receivedDate: new Date(Date.now() - (LATE_LIMIT_DAYS + 1) * 24 * 60 * 60 * 1000) },
    });
    await queueDueMessages();
    expect(await prisma.customerMessage.count()).toBe(0);
  });

  it("leaves out the order button when the store says so", async () => {
    await switchOn("ARRIVED", { includeOrderLink: false });
    const sale = await w.order();
    await w.receive(sale, 0, 1);
    await queueDueMessages();
    const [email] = await emailsTo(sale.customer.email!);
    expect(email.html).not.toContain("portal/order");
    expect(email.html).not.toContain("View your order");
  });

  it("records why it didn't write to a customer who opted out or has no email, and doesn't try again", async () => {
    await switchOn("ARRIVED");
    const optedOut = await w.order({ optOut: true });
    const noEmail = await w.order({ email: null });
    await w.receive(optedOut, 0, 1);
    await w.receive(noEmail, 0, 1);

    const summary = await queueDueMessages();
    expect(summary.ARRIVED).toEqual({ queued: 0, skipped: 2, failed: 0 });
    expect(await prisma.emailQueue.count()).toBe(0);
    const rows = await prisma.customerMessage.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((m) => [m.status, m.skipReason])).toEqual([
      ["SKIPPED", OPTED_OUT],
      ["SKIPPED", NO_EMAIL],
    ]);

    await queueDueMessages();
    expect(await prisma.customerMessage.count()).toBe(2);
  });

  it("sends one message when two runs scan at once", async () => {
    await switchOn("ARRIVED");
    const sale = await w.order();
    await w.receive(sale, 0, 1);
    const runs = await Promise.all([queueDueMessages(), queueDueMessages()]);
    // The run that lost the race says nothing failed: the message went, once.
    expect(runs.map((r) => r.ARRIVED.failed)).toEqual([0, 0]);
    expect(await prisma.customerMessage.count()).toBe(1);
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);
  });
});

describe("Your delivery is scheduled", () => {
  const today = () => businessDayKey(new Date(), TZ);

  it("announces a delivery put on a run, with its day and window, once per day", async () => {
    await switchOn("DELIVERY_SCHEDULED");
    const sale = await w.order();
    const day = addDays(today(), 3);
    const { appointmentId } = await w.schedule(sale, day);
    await prisma.serviceAppointment.update({
      where: { id: appointmentId },
      data: { scheduledTime: "9am-12pm" },
    });

    await queueDueMessages();
    const [email] = await emailsTo(sale.customer.email!);
    const date = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(runDateOf(day));
    expect(email.html).toContain(`scheduled for ${date}, 9am-12pm`);
    expect(email.html).toContain("Hartwell Sofa and 2 × Ellis Side Chair");

    await queueDueMessages();
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);

    // The run moves to another day: the customer hears the new one.
    const stop = await prisma.deliveryStop.findFirstOrThrow({
      where: { serviceAppointmentId: appointmentId },
    });
    await prisma.deliveryRun.update({
      where: { id: stop.deliveryRunId },
      data: { runDate: runDateOf(addDays(day, 2)) },
    });
    await queueDueMessages();
    expect(await emailsTo(sale.customer.email!)).toHaveLength(2);
  });

  it("announces no delivery scheduled before it was switched on, unless its day later changes after an announcement", async () => {
    const sale = await w.order();
    const day = addDays(today(), 3);
    await w.schedule(sale, day);
    await switchOn("DELIVERY_SCHEDULED");
    await queueDueMessages();
    expect(await prisma.customerMessage.count()).toBe(0);

    // Switched off and on again, a delivery it already announced is announced
    // again when its day changes.
    const other = await w.order();
    const { appointmentId } = await w.schedule(other, day);
    await queueDueMessages();
    expect(await emailsTo(other.customer.email!)).toHaveLength(1);
    await call(
      saveSetting,
      "PUT",
      { kind: "DELIVERY_SCHEDULED" },
      await settingBody("DELIVERY_SCHEDULED", { isActive: false }),
    );
    await switchOn("DELIVERY_SCHEDULED");
    const stop = await prisma.deliveryStop.findFirstOrThrow({
      where: { serviceAppointmentId: appointmentId },
    });
    await prisma.deliveryRun.update({
      where: { id: stop.deliveryRunId },
      data: { runDate: runDateOf(addDays(day, 1)) },
    });
    await queueDueMessages();
    expect(await emailsTo(other.customer.email!)).toHaveLength(2);
    expect(await emailsTo(sale.customer.email!)).toHaveLength(0);
  });

  it("announces no delivery on a past run, one already made, or one cancelled", async () => {
    await switchOn("DELIVERY_SCHEDULED");
    const past = await w.order();
    await w.schedule(past, addDays(today(), -1));
    const made = await w.order();
    const { stopId } = await w.schedule(made, addDays(today(), 2));
    await prisma.deliveryStop.update({ where: { id: stopId }, data: { status: "COMPLETED" } });
    const cancelled = await w.order();
    const { appointmentId } = await w.schedule(cancelled, addDays(today(), 2));
    await prisma.serviceAppointment.update({
      where: { id: appointmentId },
      data: { status: "CANCELLED" },
    });
    await queueDueMessages();
    expect(await prisma.customerMessage.count()).toBe(0);
  });
});

describe("Delivery reminder", () => {
  it("goes on its day from its hour, once, and not after its day", async () => {
    await onSince("DELIVERY_REMINDER", LONG_AGO, { offsetDays: 1, sendHour: 9 });
    const sale = await w.order();
    const day = "2031-06-12";
    await w.schedule(sale, day);
    const eve = "2031-06-11";

    await queueDueMessages(new Date(businessHourStart(eve, 9, TZ).getTime() - 60_000));
    expect(await prisma.customerMessage.count()).toBe(0);

    await queueDueMessages(businessHourStart(eve, 9, TZ));
    const [email] = await emailsTo(sale.customer.email!);
    expect(email.subject).toBe("Reminder: your delivery from Holt");
    expect(email.html).toContain("on Thursday, June 12: Hartwell Sofa and 2 × Ellis Side Chair");

    await queueDueMessages(businessHourStart(eve, 20, TZ));
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);

    // Booked on the delivery day itself: its reminder's day has passed.
    const late = await w.order();
    await w.schedule(late, day);
    await queueDueMessages(businessHourStart(day, 10, TZ));
    expect(await emailsTo(late.customer.email!)).toHaveLength(0);
  });

  it("sends none whose hour came before it was switched on", async () => {
    const sale = await w.order();
    await w.schedule(sale, "2031-06-12");
    await onSince("DELIVERY_REMINDER", businessHourStart("2031-06-11", 10, TZ), {
      offsetDays: 1,
      sendHour: 9,
    });
    await queueDueMessages(businessHourStart("2031-06-11", 11, TZ));
    expect(await prisma.customerMessage.count()).toBe(0);
  });
});

describe("Review invitation", () => {
  const LINK = "https://reviews.example.com/our-store";

  async function handedOver(at: Date) {
    const sale = await w.order();
    await prisma.salesOrder.update({
      where: { id: sale.order.id },
      data: { status: "FULFILLED", deliveredAt: at },
    });
    await prisma.orderLineItem.updateMany({
      where: { salesOrderId: sale.order.id },
      data: { fulfilledQty: 1 },
    });
    return sale;
  }

  it("goes the store's number of days after the handover, at its hour, with the review link", async () => {
    await onSince("REVIEW_INVITE", LONG_AGO, { offsetDays: 3, sendHour: 10, linkUrl: LINK });
    const sale = await handedOver(businessHourStart("2031-06-02", 15, TZ));

    await queueDueMessages(new Date(businessHourStart("2031-06-05", 10, TZ).getTime() - 60_000));
    expect(await prisma.customerMessage.count()).toBe(0);

    await queueDueMessages(businessHourStart("2031-06-05", 10, TZ));
    const [email] = await emailsTo(sale.customer.email!);
    expect(email.subject).toBe("How did we do?");
    expect(email.html).toContain(`href="${LINK}"`);
    expect(email.html).toContain("Leave a review");
    expect(email.html).toContain("View your order");

    await queueDueMessages(businessHourStart("2031-06-06", 10, TZ));
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);
  });

  it("isn't sent for an order being returned, a handover undone, one before it was switched on, or once a week late", async () => {
    await onSince("REVIEW_INVITE", businessHourStart("2031-06-01", 0, TZ), {
      offsetDays: 3,
      sendHour: 10,
      linkUrl: LINK,
    });
    const returning = await handedOver(businessHourStart("2031-06-02", 15, TZ));
    await prisma.return.create({
      data: {
        returnNumber: "RET-1",
        salesOrderId: returning.order.id,
        customerId: returning.customer.id,
        reason: "CUSTOMER_CHANGED_MIND",
      },
    });
    const undone = await handedOver(businessHourStart("2031-06-02", 15, TZ));
    await prisma.salesOrder.update({
      where: { id: undone.order.id },
      data: { status: "ORDER", deliveredAt: null },
    });
    await handedOver(businessHourStart("2031-05-30", 15, TZ));
    // No longer a handed-over sale, whatever its handover time says.
    const cancelled = await handedOver(businessHourStart("2031-06-02", 15, TZ));
    await prisma.salesOrder.update({
      where: { id: cancelled.order.id },
      data: { status: "CANCELLED" },
    });
    const good = await handedOver(businessHourStart("2031-06-02", 15, TZ));

    await queueDueMessages(businessHourStart("2031-06-05", 10, TZ));
    expect((await prisma.customerMessage.findMany()).map((m) => m.salesOrderId)).toEqual([
      good.order.id,
    ]);

    const stale = await handedOver(businessHourStart("2031-06-03", 15, TZ));
    await queueDueMessages(businessHourStart(addDays("2031-06-06", LATE_LIMIT_DAYS + 1), 10, TZ));
    expect(await emailsTo(stale.customer.email!)).toHaveLength(0);
  });
});

describe("Who", () => {
  /** Staff for each role, an administrator among them (with none, the bootstrap safeguard admits anyone). */
  async function staff() {
    await syncBuiltInRoles({ prisma });
    invalidateRoleGrantCache();
    for (const key of ["DESIGNER", "ADMIN"] as const) {
      const email = `${key.toLowerCase()}@example.com`;
      await prisma.user.create({ data: { id: key, email } });
      const role = await prisma.role.findUniqueOrThrow({ where: { key } });
      await prisma.staffMember.create({
        data: { userId: key, email, displayName: key, role: key, roleId: role.id },
      });
    }
  }

  async function status(
    as: "DESIGNER" | "ADMIN",
    route: (q: NextApiRequest, r: NextApiResponse) => unknown,
    method: string,
    query: Record<string, string>,
    body?: unknown,
  ) {
    sessionMock.mockResolvedValue({ user: { id: as, email: `${as.toLowerCase()}@example.com` } });
    const res = makeRes();
    await route(
      { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
      res,
    );
    return res.statusCode;
  }

  it("sets up messages with Settings access, and lets anyone who reads sales see an order's", async () => {
    const sale = await w.order();
    const body = await settingBody("ARRIVED", { isActive: true });
    await staff();
    expect(await status("DESIGNER", listRoute, "GET", {})).toBe(403);
    expect(await status("DESIGNER", saveRoute, "PUT", { kind: "ARRIVED" }, body)).toBe(403);
    expect(
      await status("DESIGNER", orderMessagesDefault, "GET", { id: String(sale.order.id) }),
    ).toBe(200);
    expect(await status("ADMIN", saveRoute, "PUT", { kind: "ARRIVED" }, body)).toBe(200);
  });
});

describe("Where it runs and where it shows", () => {
  const OLD_KEY = process.env.AUTO_IMPORT_API_KEY;
  afterEach(() => {
    process.env.AUTO_IMPORT_API_KEY = OLD_KEY;
  });

  it("the email-queue cron queues what is due, then drains", async () => {
    process.env.AUTO_IMPORT_API_KEY = "test-key";
    await switchOn("ARRIVED");
    const sale = await w.order();
    await w.receive(sale, 0, 1);
    const res = makeRes();
    await emailQueueRoute(
      {
        method: "POST",
        query: {},
        cookies: {},
        headers: { authorization: "Bearer test-key" },
      } as unknown as NextApiRequest,
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.messages.ARRIVED.queued).toBe(1);
    expect(await emailsTo(sale.customer.email!)).toHaveLength(1);
  });

  it("the order page lists each message and where it stands", async () => {
    await switchOn("ARRIVED");
    const sale = await w.order();
    const optedOut = await w.order({ optOut: true });
    await w.receive(sale, 0, 1);
    await w.receive(optedOut, 0, 1);
    await queueDueMessages();

    const res = await call(orderMessagesRoute, "GET", { id: String(sale.order.id) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        label: "Your furniture has arrived",
        status: "QUEUED",
        emailStatus: "PENDING",
        toAddress: sale.customer.email,
      }),
    ]);
    const skipped = await call(orderMessagesRoute, "GET", { id: String(optedOut.order.id) });
    expect(skipped.body).toEqual([
      expect.objectContaining({ status: "SKIPPED", skipReason: OPTED_OUT, emailStatus: null }),
    ]);
  });

  it("the customer record keeps a customer's no-automatic-messages choice", async () => {
    const { customer } = await w.order();
    const put = (body: unknown) =>
      call(customerRoute.PUT as Handler, "PUT", { id: String(customer.id) }, body);
    const res = await put({ autoMessagesOptOut: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.autoMessagesOptOut).toBe(true);
    expect((await put({ autoMessagesOptOut: "yes" })).statusCode).toBe(400);
    // A save that doesn't send the choice leaves it as it was.
    await put({ firstName: "Jo" });
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).autoMessagesOptOut,
    ).toBe(true);
  });
});
