// /app/src/lib/sales/orderDisclaimers.ts
//
// GAP-07: a disclaimer printed on an order, beside the store-wide receiptFooter
// (owner, 2026-11-03: picked from the store's own list).
//
//   OrderDisclaimer       the store's list, written in Settings > Disclaimers --
//                         "Sold as-is", "Special order: no cancellations". No
//                         fixed set ships.
//   SalesOrderDisclaimer  one on an order: its text COPIED as it read, the way a
//                         service checklist is copied onto a case (DECISIONS 30).
//                         What the customer was given doesn't change when the
//                         store rewords or deletes the disclaimer later.
//
// An order's disclaimers change only while it is a quote or an order. Once it
// is handed over, they are what the customer took the goods under; a
// cancelled order is finished.

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DISCLAIMER_NAME_MAX,
  DISCLAIMER_TEXT_MAX,
  type OrderDisclaimerRef,
  disclaimerEditProblem,
} from "@/lib/sales/orderDisclaimersShared";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class DisclaimerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "DisclaimerError";
  }
}

export interface DisclaimerInput {
  name?: unknown;
  text?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
}

/** The store's disclaimers, in order; `activeOnly` for a picker. */
export function listDisclaimers(db: Db, opts: { activeOnly?: boolean } = {}) {
  return db.orderDisclaimer.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { orders: true } } },
  });
}

function readText(raw: unknown, what: "name" | "text", max: number): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new DisclaimerError(
      what === "name" ? "Give the disclaimer a name." : "Write the disclaimer's text.",
    );
  }
  if (value.length > max) throw new DisclaimerError(`Keep the ${what} under ${max} characters.`);
  return value;
}

function readOptionalFields(input: DisclaimerInput): { isActive?: boolean; sortOrder?: number } {
  const out: { isActive?: boolean; sortOrder?: number } = {};
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean") {
      throw new DisclaimerError("isActive must be true or false.");
    }
    out.isActive = input.isActive;
  }
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new DisclaimerError("sortOrder must be a whole number.");
    }
    out.sortOrder = input.sortOrder;
  }
  return out;
}

async function assertNameFree(db: Db, name: string, exceptId?: number): Promise<void> {
  const clash = await db.orderDisclaimer.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new DisclaimerError(`There is already a disclaimer called "${name}".`, 409);
}

export async function createDisclaimer(db: Tx, input: DisclaimerInput, by: string | null) {
  const name = readText(input.name, "name", DISCLAIMER_NAME_MAX);
  const text = readText(input.text, "text", DISCLAIMER_TEXT_MAX);
  await assertNameFree(db, name);
  return db.orderDisclaimer.create({
    data: { name, text, ...readOptionalFields(input), createdBy: by },
  });
}

/** Reword, rename, reorder or switch off. Orders already given it keep their copy. */
export async function updateDisclaimer(
  db: Tx,
  id: number,
  input: DisclaimerInput,
  by: string | null,
) {
  const current = await db.orderDisclaimer.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new DisclaimerError("Disclaimer not found.", 404);
  const name =
    input.name === undefined ? undefined : readText(input.name, "name", DISCLAIMER_NAME_MAX);
  const text =
    input.text === undefined ? undefined : readText(input.text, "text", DISCLAIMER_TEXT_MAX);
  if (name !== undefined) await assertNameFree(db, name, id);
  return db.orderDisclaimer.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...readOptionalFields(input),
      updatedBy: by,
    },
  });
}

/** Delete a disclaimer. Orders already given it keep its text. */
export async function deleteDisclaimer(db: Tx, id: number): Promise<void> {
  const current = await db.orderDisclaimer.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new DisclaimerError("Disclaimer not found.", 404);
  await db.orderDisclaimer.delete({ where: { id } });
}

/** An order's disclaimers, in the order they were added. */
export function orderDisclaimersOf(db: Db, salesOrderId: number): Promise<OrderDisclaimerRef[]> {
  return db.salesOrderDisclaimer.findMany({
    where: { salesOrderId },
    orderBy: { id: "asc" },
    select: { id: true, orderDisclaimerId: true, text: true },
  });
}

async function editableOrder(db: Tx, salesOrderId: number): Promise<void> {
  const order = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { status: true },
  });
  if (!order) throw new DisclaimerError("Order not found.", 404);
  const problem = disclaimerEditProblem(order.status);
  if (problem) throw new DisclaimerError(problem, 409);
}

/** Copy one of the store's disclaimers onto an order. */
export async function addOrderDisclaimer(
  db: Tx,
  input: { salesOrderId: number; orderDisclaimerId: unknown; actor: string | null },
): Promise<OrderDisclaimerRef[]> {
  if (typeof input.orderDisclaimerId !== "number" || !Number.isInteger(input.orderDisclaimerId)) {
    throw new DisclaimerError("orderDisclaimerId must be a disclaimer id.");
  }
  await editableOrder(db, input.salesOrderId);
  const disclaimer = await db.orderDisclaimer.findUnique({
    where: { id: input.orderDisclaimerId },
    select: { id: true, name: true, text: true, isActive: true },
  });
  if (!disclaimer) throw new DisclaimerError("That disclaimer doesn't exist.");
  if (!disclaimer.isActive) {
    throw new DisclaimerError(`"${disclaimer.name}" is switched off in Settings.`);
  }
  const already = await db.salesOrderDisclaimer.findFirst({
    where: { salesOrderId: input.salesOrderId, orderDisclaimerId: disclaimer.id },
    select: { id: true },
  });
  if (already) throw new DisclaimerError(`"${disclaimer.name}" is already on this order.`, 409);

  await db.salesOrderDisclaimer.create({
    data: {
      salesOrderId: input.salesOrderId,
      orderDisclaimerId: disclaimer.id,
      text: disclaimer.text,
      createdBy: input.actor,
    },
  });
  await db.orderChangeLog.create({
    data: {
      salesOrderId: input.salesOrderId,
      changeType: "DISCLAIMER_ADDED",
      newValue: disclaimer.name,
      changedBy: input.actor,
    },
  });
  return orderDisclaimersOf(db, input.salesOrderId);
}

/** Take a disclaimer off an order. */
export async function removeOrderDisclaimer(
  db: Tx,
  input: { salesOrderId: number; id: number; actor: string | null },
): Promise<OrderDisclaimerRef[]> {
  await editableOrder(db, input.salesOrderId);
  const row = await db.salesOrderDisclaimer.findFirst({
    where: { id: input.id, salesOrderId: input.salesOrderId },
    select: { id: true, text: true },
  });
  if (!row) throw new DisclaimerError("That disclaimer isn't on this order.", 404);
  await db.salesOrderDisclaimer.delete({ where: { id: row.id } });
  await db.orderChangeLog.create({
    data: {
      salesOrderId: input.salesOrderId,
      changeType: "DISCLAIMER_REMOVED",
      previousValue: row.text,
      changedBy: input.actor,
    },
  });
  return orderDisclaimersOf(db, input.salesOrderId);
}
