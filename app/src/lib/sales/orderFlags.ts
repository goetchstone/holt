// /app/src/lib/sales/orderFlags.ts
//
// GAP-07: flags on an order (owner, 2026-11-03: the store's own).
//
//   OrderFlag       the store's list, set up in Settings > Order flags -- no
//                   fixed set ships ("Call before delivery", "Fragile", "VIP"
//                   are a store's own words). A flag can warn whoever opens an
//                   order carrying it. One orders carry is switched off, never
//                   deleted, so they keep it.
//   SalesOrderFlag  a flag on an order. Shown on the order, the orders list
//                   and dispatch; the orders list filters by it.
//
// setOrderFlags is the one write of an order's flags, so a switched-off flag
// can't be put on an order and every change leaves a change-log row.

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ORDER_FLAG_COLORS,
  ORDER_FLAG_NAME_MAX,
  type OrderFlagRef,
  flagRefsOf,
  isOrderFlagColor,
} from "@/lib/sales/orderFlagsShared";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class OrderFlagError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "OrderFlagError";
  }
}

export interface OrderFlagInput {
  name?: unknown;
  color?: unknown;
  alertOnOpen?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
}

/** What every screen that draws a flag reads (OrderFlagRef). */
export const ORDER_FLAG_REF_SELECT = {
  id: true,
  name: true,
  color: true,
  alertOnOpen: true,
} satisfies Prisma.OrderFlagSelect;

/** The store's flags, in order; `activeOnly` for a picker. */
export function listOrderFlags(db: Db, opts: { activeOnly?: boolean } = {}) {
  return db.orderFlag.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { orders: true } } },
  });
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new OrderFlagError("Give the flag a name.");
  if (name.length > ORDER_FLAG_NAME_MAX) {
    throw new OrderFlagError(`Keep the name under ${ORDER_FLAG_NAME_MAX} characters.`);
  }
  return name;
}

function readBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw new OrderFlagError(`${field} must be true or false.`);
  return raw;
}

interface OrderFlagFields {
  color?: string;
  alertOnOpen?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

function readOptionalFields(input: OrderFlagInput): OrderFlagFields {
  const out: OrderFlagFields = {};
  if (input.color !== undefined) {
    if (!isOrderFlagColor(input.color)) {
      throw new OrderFlagError(`A flag's colour is one of ${ORDER_FLAG_COLORS.join(", ")}.`);
    }
    out.color = input.color;
  }
  if (input.alertOnOpen !== undefined) {
    out.alertOnOpen = readBoolean(input.alertOnOpen, "alertOnOpen");
  }
  if (input.isActive !== undefined) out.isActive = readBoolean(input.isActive, "isActive");
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new OrderFlagError("sortOrder must be a whole number.");
    }
    out.sortOrder = input.sortOrder;
  }
  return out;
}

async function assertNameFree(db: Db, name: string, exceptId?: number): Promise<void> {
  const clash = await db.orderFlag.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new OrderFlagError(`There is already a flag called "${name}".`, 409);
}

export async function createOrderFlag(db: Tx, input: OrderFlagInput, by: string | null) {
  const name = readName(input.name);
  await assertNameFree(db, name);
  return db.orderFlag.create({
    data: { name, ...readOptionalFields(input), createdBy: by },
  });
}

export async function updateOrderFlag(
  db: Tx,
  id: number,
  input: OrderFlagInput,
  by: string | null,
) {
  const current = await db.orderFlag.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new OrderFlagError("Flag not found.", 404);
  const name = input.name === undefined ? undefined : readName(input.name);
  if (name !== undefined) await assertNameFree(db, name, id);
  return db.orderFlag.update({
    where: { id },
    data: { ...(name !== undefined ? { name } : {}), ...readOptionalFields(input), updatedBy: by },
  });
}

/** Delete a flag no order carries; one in use is switched off instead. */
export async function deleteOrderFlag(db: Tx, id: number): Promise<void> {
  const current = await db.orderFlag.findUnique({
    where: { id },
    include: { _count: { select: { orders: true } } },
  });
  if (!current) throw new OrderFlagError("Flag not found.", 404);
  if (current._count.orders > 0) {
    throw new OrderFlagError(
      `${current._count.orders} order(s) carry "${current.name}". Switch it off instead, so they keep it.`,
      409,
    );
  }
  await db.orderFlag.delete({ where: { id } });
}

function readFlagIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "number" && Number.isInteger(v))) {
    throw new OrderFlagError("flagIds must be a list of flag ids.");
  }
  return [...new Set(raw as number[])];
}

/** An order's flags as a query selects them, for flagRefsOf (orderFlagsShared). */
export const ORDER_FLAGS_SELECT = {
  select: { orderFlag: { select: { ...ORDER_FLAG_REF_SELECT, sortOrder: true } } },
} satisfies Prisma.SalesOrder$flagsArgs;

/** An order's flags, in the store's order. */
export async function orderFlagsOf(db: Db, salesOrderId: number): Promise<OrderFlagRef[]> {
  return flagRefsOf(
    await db.salesOrderFlag.findMany({ where: { salesOrderId }, ...ORDER_FLAGS_SELECT }),
  );
}

/**
 * Set the flags on an order to exactly `flagIds`. A flag being added must be
 * switched on; one the order already carries may stay after it is switched off.
 * Each flag added or taken off leaves a change-log row.
 */
export async function setOrderFlags(
  db: Tx,
  input: { salesOrderId: number; flagIds: unknown; actor: string | null },
): Promise<OrderFlagRef[]> {
  const wanted = readFlagIds(input.flagIds);
  const order = await db.salesOrder.findUnique({
    where: { id: input.salesOrderId },
    select: { id: true, flags: { select: { orderFlagId: true } } },
  });
  if (!order) throw new OrderFlagError("Order not found.", 404);

  const current = new Set(order.flags.map((f) => f.orderFlagId));
  const flags = await db.orderFlag.findMany({
    where: { id: { in: [...new Set([...wanted, ...current])] } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(flags.map((f) => [f.id, f]));
  const adding = wanted.filter((id) => !current.has(id));
  const removing = [...current].filter((id) => !wanted.includes(id));

  for (const id of adding) {
    const flag = byId.get(id);
    if (!flag) throw new OrderFlagError("That flag doesn't exist.");
    if (!flag.isActive) throw new OrderFlagError(`"${flag.name}" is switched off in Settings.`);
  }

  if (removing.length > 0) {
    await db.salesOrderFlag.deleteMany({
      where: { salesOrderId: order.id, orderFlagId: { in: removing } },
    });
  }
  if (adding.length > 0) {
    await db.salesOrderFlag.createMany({
      data: adding.map((orderFlagId) => ({
        salesOrderId: order.id,
        orderFlagId,
        createdBy: input.actor,
      })),
    });
  }
  const changes = [
    ...adding.map((id) => ({ changeType: "FLAG_ADDED", newValue: byId.get(id)!.name })),
    ...removing.map((id) => ({ changeType: "FLAG_REMOVED", previousValue: byId.get(id)!.name })),
  ];
  if (changes.length > 0) {
    await db.orderChangeLog.createMany({
      data: changes.map((c) => ({ ...c, salesOrderId: order.id, changedBy: input.actor })),
    });
  }
  return orderFlagsOf(db, order.id);
}
