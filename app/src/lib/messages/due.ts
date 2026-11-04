// /app/src/lib/messages/due.ts
//
// GAP-13: find the customer messages that are due, and queue them. The
// email-queue cron (/api/automations/email-queue, every 5 minutes by
// scripts/install-cron.sh) runs this before it drains the queue, so a message
// goes within one run of its event.
//
// Only kinds the store switched on (Settings › Customer messages), and only
// events after it switched each one on (CustomerMessageSetting.activeSince):
// switching a message on sends nothing about what had already happened.
//
//   ARRIVED            a receipt against a PO line ordered for the order: goods
//                      that came onto the books in a saleable condition, not
//                      one imported from another system's history. One message
//                      per order lists what came in; each receipt is announced
//                      once (CustomerMessage.receivingRecordIds).
//   DELIVERY_SCHEDULED a delivery on a run for today or later. Once per
//                      delivery and day, so a delivery moved to another day is
//                      announced again.
//   DELIVERY_REMINDER  on its day from its hour (lib/messages/timing.ts
//                      reminderDueAt), for a delivery still to be made; never
//                      late.
//   REVIEW_INVITE      once per order, offsetDays after its handover, while the
//                      order is still handed over and nothing on it is being
//                      returned.
//
// Each event is recorded once (CustomerMessage.dedupeKey), sent or not. A
// customer who asked for no automatic messages (Customer.autoMessagesOptOut),
// or who can't be reached by the channels the message takes (no email; for a
// text, lib/sms/consent.ts), gets a row saying why and is not tried again for
// that event. The row, its email and its text are written together, so two runs
// at once send one message.
//
// A message more than LATE_LIMIT_DAYS late (the cron was off) isn't sent at
// all: by then its news is old.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { enqueueEmail } from "@/lib/email/queue";
import { enqueueSms } from "@/lib/sms/queue";
import { textableNumber } from "@/lib/sms/consent";
import { getErrorCode } from "@/lib/errorCode";
import { logError } from "@/lib/logger";
import { portalOrderUrl } from "@/lib/portalLink";
import { openStopLines } from "@/lib/fulfilment/deliveredLines";
import { QUARANTINED_CONDITIONS } from "@/lib/purchasing/receiptConditions";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import { MESSAGE_KINDS, channelsFor, type MessageKind } from "./catalog";
import { getMessageSettings, type MessageSettingRow } from "./settings";
import {
  customerName,
  describePieces,
  describeWhen,
  renderCustomerMessage,
  renderTextMessage,
  type PlaceholderValues,
} from "./render";
import { reminderDueAt, reviewDueAt, runDateOf, runDay } from "./timing";

export const LATE_LIMIT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NO_CUSTOMER = "The order has no customer.";
export const OPTED_OUT = "The customer asked for no automatic messages.";
export const NO_EMAIL = "The customer has no email address.";

const ORDER_SELECT = {
  id: true,
  orderno: true,
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      autoMessagesOptOut: true,
      smsConsentAt: true,
      preferredChannel: true,
    },
  },
  lineItems: {
    select: {
      id: true,
      productId: true,
      productName: true,
      orderedQuantity: true,
      fulfilledQty: true,
      lineItemStatus: true,
    },
  },
} satisfies Prisma.SalesOrderSelect;

type OrderFacts = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_SELECT }>;

interface Context {
  now: Date;
  timeZone: string;
  locale: string;
  storeName: string;
  ttlHours: number | null;
}

/** An active kind's setting, with the moment it was switched on. */
type ActiveSetting = MessageSettingRow & { activeSince: Date };

export interface KindSummary {
  queued: number;
  skipped: number;
  failed: number;
}

export type DueSummary = Record<MessageKind, KindSummary>;

interface Message {
  dedupeKey: string;
  order: OrderFacts;
  values: PlaceholderValues;
  receivingRecordIds?: number[];
}

/** Why nothing at all goes to this order's customer, whichever the channel. */
function nobodyToWrite(order: OrderFacts): string | null {
  if (!order.customer) return NO_CUSTOMER;
  if (order.customer.autoMessagesOptOut) return OPTED_OUT;
  return null;
}

type Customer = NonNullable<OrderFacts["customer"]>;
type Tx = Prisma.TransactionClient;

const templateKey = (setting: ActiveSetting) =>
  `customer-message-${setting.kind.toLowerCase().replace(/_/g, "-")}`;

function fillIns(ctx: Context, m: Message, customer: Customer): PlaceholderValues {
  return {
    customer: customerName(customer),
    order: m.order.orderno,
    store: ctx.storeName,
    ...m.values,
  };
}

/** The email, queued: where it went, or why it didn't. */
async function queueEmail(
  tx: Tx,
  ctx: Context,
  setting: ActiveSetting,
  m: Message,
  customer: Customer,
): Promise<{ toAddress: string; emailQueueId: number } | { skipReason: string }> {
  const toAddress = customer.email?.trim();
  if (!toAddress) return { skipReason: NO_EMAIL };
  const email = renderCustomerMessage({
    subject: setting.subject,
    body: setting.body,
    storeName: ctx.storeName,
    values: fillIns(ctx, m, customer),
    orderUrl: setting.includeOrderLink
      ? portalOrderUrl(m.order.id, customer.id, ctx.ttlHours)
      : null,
    reviewUrl: setting.kind === "REVIEW_INVITE" ? setting.linkUrl : null,
  });
  const emailQueueId = await enqueueEmail(
    {
      to: toAddress,
      subject: email.subject,
      html: email.html,
      templateKey: templateKey(setting),
      createdBy: "system",
    },
    tx,
  );
  return { toAddress, emailQueueId };
}

/** The text, queued: where it went, or why it didn't. */
async function queueText(
  tx: Tx,
  ctx: Context,
  setting: ActiveSetting,
  m: Message,
  customer: Customer,
): Promise<{ toPhone: string; smsQueueId: number } | { smsSkipReason: string }> {
  const number = await textableNumber(tx, customer, ctx.locale);
  if ("problem" in number) return { smsSkipReason: number.problem };
  const body = renderTextMessage({
    body: setting.textBody,
    values: fillIns(ctx, m, customer),
    orderUrl: setting.textIncludeOrderLink
      ? portalOrderUrl(m.order.id, customer.id, ctx.ttlHours)
      : null,
    reviewUrl: setting.kind === "REVIEW_INVITE" ? setting.linkUrl : null,
  });
  const smsQueueId = await enqueueSms(
    { to: number.phone, body, templateKey: templateKey(setting), createdBy: "system" },
    tx,
  );
  return { toPhone: number.phone, smsQueueId };
}

/** Record one message, queuing what it takes; nothing when another run recorded it first. */
async function send(
  ctx: Context,
  setting: ActiveSetting,
  m: Message,
  summary: KindSummary,
): Promise<void> {
  const customer = m.order.customer;
  const nobody = nobodyToWrite(m.order);
  try {
    const queued = await prisma.$transaction(async (tx) => {
      const wanted = customer
        ? channelsFor(setting.channel, customer.preferredChannel)
        : { email: false, text: false };
      const reachable = customer && !nobody;
      const email =
        reachable && wanted.email ? await queueEmail(tx, ctx, setting, m, customer) : {};
      const text = reachable && wanted.text ? await queueText(tx, ctx, setting, m, customer) : {};
      const anything = "emailQueueId" in email || "smsQueueId" in text;
      await tx.customerMessage.create({
        data: {
          kind: setting.kind,
          dedupeKey: m.dedupeKey,
          salesOrderId: m.order.id,
          customerId: customer?.id ?? null,
          status: anything ? "QUEUED" : "SKIPPED",
          skipReason: nobody,
          ...email,
          ...text,
          receivingRecordIds: m.receivingRecordIds ?? [],
        },
      });
      return anything;
    });
    if (queued) summary.queued++;
    else summary.skipped++;
  } catch (err) {
    // Another run recorded this event first: it is sent once, by that run.
    if (getErrorCode(err) === "P2002") return;
    summary.failed++;
    logError("Customer message could not be queued", err, {
      kind: setting.kind,
      dedupeKey: m.dedupeKey,
    });
  }
}

async function ordersById(ids: number[]): Promise<Map<number, OrderFacts>> {
  const orders = await prisma.salesOrder.findMany({
    where: { id: { in: ids } },
    select: ORDER_SELECT,
  });
  return new Map(orders.map((o) => [o.id, o]));
}

/** The pieces a delivery brings: the stop's open lines, as the driver sees them. */
function deliveryPieces(order: OrderFacts): string {
  const lines = order.lineItems.map((l) => ({
    ...l,
    orderedQuantity: Number(l.orderedQuantity),
    fulfilledQty: Number(l.fulfilledQty ?? 0),
  }));
  return describePieces(openStopLines(lines).map((l) => ({ name: l.name, quantity: l.open })));
}

// ---- ARRIVED ----------------------------------------------------------------

async function dueArrivals(ctx: Context, setting: ActiveSetting, summary: KindSummary) {
  const lateLimit = new Date(ctx.now.getTime() - LATE_LIMIT_DAYS * DAY_MS);
  const since = setting.activeSince > lateLimit ? setting.activeSince : lateLimit;
  const receipts = await prisma.receivingRecord.findMany({
    where: {
      receivedDate: { gte: since },
      quantityReceived: { gt: 0 },
      // Goods that came onto the books (GAP-21), in a saleable condition, and
      // received here rather than imported from another system's history.
      intoStock: true,
      OR: [{ condition: null }, { condition: { notIn: [...QUARANTINED_CONDITIONS] } }],
      externalGipNo: null,
      purchaseOrderItem: {
        orderLineItem: {
          is: {
            lineItemStatus: { in: ["ACTIVE", "BACKORDERED"] },
            salesOrder: { status: "ORDER", deliveredAt: null },
          },
        },
      },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      quantityReceived: true,
      purchaseOrderItem: {
        select: { orderLineItem: { select: { id: true, productName: true, salesOrderId: true } } },
      },
    },
  });
  if (receipts.length === 0) return;

  const announced = new Set(
    (
      await prisma.customerMessage.findMany({
        where: { kind: "ARRIVED", receivingRecordIds: { hasSome: receipts.map((r) => r.id) } },
        select: { receivingRecordIds: true },
      })
    ).flatMap((m) => m.receivingRecordIds),
  );

  const byOrder = new Map<number, typeof receipts>();
  for (const r of receipts) {
    const line = r.purchaseOrderItem.orderLineItem;
    if (!line || announced.has(r.id)) continue;
    byOrder.set(line.salesOrderId, [...(byOrder.get(line.salesOrderId) ?? []), r]);
  }
  const orders = await ordersById([...byOrder.keys()]);
  for (const [orderId, rows] of byOrder) {
    const order = orders.get(orderId);
    if (!order) continue;
    const perLine = new Map<number, { name: string; quantity: number }>();
    for (const r of rows) {
      const line = r.purchaseOrderItem.orderLineItem!;
      const piece = perLine.get(line.id) ?? {
        name: line.productName || "Unnamed item",
        quantity: 0,
      };
      piece.quantity += Number(r.quantityReceived);
      perLine.set(line.id, piece);
    }
    const ids = rows.map((r) => r.id);
    await send(
      ctx,
      setting,
      {
        // Each receipt is announced once, so the batch's first is unique to it.
        dedupeKey: `ARRIVED:${Math.min(...ids)}`,
        order,
        values: { pieces: describePieces([...perLine.values()]) },
        receivingRecordIds: ids,
      },
      summary,
    );
  }
}

// ---- Deliveries -------------------------------------------------------------

/** Deliveries still to be made, on runs for `runDates`. */
async function deliveriesOn(runDates: Prisma.DateTimeFilter) {
  return prisma.serviceAppointment.findMany({
    where: {
      type: "DELIVERY",
      status: { notIn: ["CANCELLED", "COMPLETED"] },
      deliveryStop: { is: { status: { not: "COMPLETED" }, deliveryRun: { runDate: runDates } } },
      salesOrder: { status: "ORDER", deliveredAt: null },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      salesOrderId: true,
      scheduledTime: true,
      deliveryStop: { select: { created: true, deliveryRun: { select: { runDate: true } } } },
    },
  });
}

async function dueScheduled(ctx: Context, setting: ActiveSetting, summary: KindSummary) {
  const today = businessDayKey(ctx.now, ctx.timeZone);
  const appts = await deliveriesOn({ gte: runDateOf(today) });
  const keyed = appts.flatMap((a) =>
    a.deliveryStop
      ? [{ a, day: runDay(a.deliveryStop.deliveryRun.runDate), stop: a.deliveryStop }]
      : [],
  );
  const keyOf = (apptId: number, day: string) => `DELIVERY_SCHEDULED:${apptId}:${day}`;
  const done = new Set(
    (
      await prisma.customerMessage.findMany({
        where: { dedupeKey: { in: keyed.map((k) => keyOf(k.a.id, k.day)) } },
        select: { dedupeKey: true },
      })
    ).map((m) => m.dedupeKey),
  );
  const fresh = keyed.filter((k) => !done.has(keyOf(k.a.id, k.day)));
  // A delivery scheduled before the message was switched on is announced only
  // if it was announced before (the store switched it off and on again) and
  // its day has since changed.
  const older = fresh.filter((k) => k.stop.created < setting.activeSince);
  const announcedBefore = new Set(
    older.length === 0
      ? []
      : (
          await prisma.customerMessage.findMany({
            where: {
              kind: "DELIVERY_SCHEDULED",
              OR: older.map((k) => ({
                dedupeKey: { startsWith: `DELIVERY_SCHEDULED:${k.a.id}:` },
              })),
            },
            select: { dedupeKey: true },
          })
        ).map((m) => Number(m.dedupeKey.split(":")[1])),
  );
  const due = fresh.filter(
    (k) => k.stop.created >= setting.activeSince || announcedBefore.has(k.a.id),
  );
  const orders = await ordersById(due.map((k) => k.a.salesOrderId));
  for (const k of due) {
    const order = orders.get(k.a.salesOrderId);
    if (!order) continue;
    await send(
      ctx,
      setting,
      {
        dedupeKey: keyOf(k.a.id, k.day),
        order,
        values: {
          pieces: deliveryPieces(order),
          when: describeWhen(k.day, k.a.scheduledTime, ctx.locale),
        },
      },
      summary,
    );
  }
}

async function dueReminders(ctx: Context, setting: ActiveSetting, summary: KindSummary) {
  if (setting.offsetDays == null || setting.sendHour == null) return;
  // Only deliveries whose reminder day is today: a reminder that couldn't go
  // on its day (the delivery was booked later) isn't sent late.
  const today = businessDayKey(ctx.now, ctx.timeZone);
  const day = addDays(today, setting.offsetDays);
  const dueAt = reminderDueAt(day, setting.offsetDays, setting.sendHour, ctx.timeZone);
  // Not yet its hour, or its hour came before the reminder was switched on.
  if (ctx.now < dueAt || dueAt < setting.activeSince) return;
  const appts = await deliveriesOn({ gte: runDateOf(day), lt: runDateOf(addDays(day, 1)) });
  const orders = await ordersById(appts.map((a) => a.salesOrderId));
  for (const a of appts) {
    const order = orders.get(a.salesOrderId);
    if (!order) continue;
    await send(
      ctx,
      setting,
      {
        dedupeKey: `DELIVERY_REMINDER:${a.id}:${day}`,
        order,
        values: {
          pieces: deliveryPieces(order),
          when: describeWhen(day, a.scheduledTime, ctx.locale),
        },
      },
      summary,
    );
  }
}

// ---- REVIEW_INVITE ----------------------------------------------------------

async function dueReviews(ctx: Context, setting: ActiveSetting, summary: KindSummary) {
  const { offsetDays, sendHour, linkUrl } = setting;
  if (offsetDays == null || sendHour == null || !linkUrl) return;
  // Handovers whose invitation can still be due: no earlier than the late
  // limit allows (with a day for the send hour and the zone).
  const earliest = new Date(ctx.now.getTime() - (offsetDays + LATE_LIMIT_DAYS + 1) * DAY_MS);
  const orders = await prisma.salesOrder.findMany({
    where: {
      status: "FULFILLED",
      deliveredAt: {
        gte: setting.activeSince > earliest ? setting.activeSince : earliest,
        lte: ctx.now,
      },
      returns: { none: { status: { not: "CANCELLED" } } },
      customerMessages: { none: { kind: "REVIEW_INVITE" } },
    },
    orderBy: { id: "asc" },
    select: { ...ORDER_SELECT, deliveredAt: true },
  });
  for (const order of orders) {
    if (!order.deliveredAt) continue;
    const dueAt = reviewDueAt(order.deliveredAt, offsetDays, sendHour, ctx.timeZone);
    if (dueAt > ctx.now || ctx.now.getTime() - dueAt.getTime() > LATE_LIMIT_DAYS * DAY_MS) {
      continue;
    }
    const delivered = order.lineItems
      .filter((l) => l.productId != null && l.lineItemStatus === "ACTIVE")
      .map((l) => ({
        name: l.productName || "Unnamed item",
        quantity: Number(l.fulfilledQty ?? 0),
      }))
      .filter((p) => p.quantity > 0);
    await send(
      ctx,
      setting,
      {
        dedupeKey: `REVIEW_INVITE:${order.id}`,
        order,
        values: { pieces: describePieces(delivered) },
      },
      summary,
    );
  }
}

const SCANS: Record<
  MessageKind,
  (ctx: Context, setting: ActiveSetting, summary: KindSummary) => Promise<void>
> = {
  ARRIVED: dueArrivals,
  DELIVERY_SCHEDULED: dueScheduled,
  DELIVERY_REMINDER: dueReminders,
  REVIEW_INVITE: dueReviews,
};

/** Queue every customer message that is due at `now`. */
export async function queueDueMessages(now: Date = new Date()): Promise<DueSummary> {
  const app = await getAppSettings();
  const ctx: Context = {
    now,
    timeZone: app.timezone,
    locale: app.locale,
    storeName: app.companyName?.trim() || app.appName,
    ttlHours: app.portalTokenTtlHours,
  };
  const settings = await getMessageSettings();
  const summary = Object.fromEntries(
    MESSAGE_KINDS.map((k) => [k, { queued: 0, skipped: 0, failed: 0 }]),
  ) as DueSummary;
  for (const setting of settings) {
    if (!setting.isActive || !setting.activeSince) continue;
    await SCANS[setting.kind](ctx, setting as ActiveSetting, summary[setting.kind]);
  }
  return summary;
}
