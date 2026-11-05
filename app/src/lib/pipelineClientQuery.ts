// /app/src/lib/pipelineClientQuery.ts
//
// Server-only fetches behind the pipeline's client context: the notes a designer
// keeps on a client, and what that client last bought. Split from the API handler
// so they are real-DB testable and Prisma stays out of the pure helpers.

import { prisma } from "@/lib/prisma";
import { CLIENT_NOTE_SOURCE } from "@/lib/interactionSources";
import {
  distinctLocations,
  topBrands,
  type ClientBackground,
  type LastPurchase,
} from "@/lib/pipelineClient";

const MAX_NOTES_PER_CLIENT = 25;
const LAST_PURCHASE_ITEM_COUNT = 3;

const CLIENT_NOTE_SELECT = {
  id: true,
  customerId: true,
  source: true,
  notes: true,
  startedAt: true,
  createdBy: true,
  staffMember: { select: { displayName: true } },
} as const;

export interface ClientNoteRow {
  id: number;
  source: string;
  notes: string | null;
  startedAt: Date;
  createdBy: string | null;
  staffMember: { displayName: string };
}

export async function fetchClientNotesByCustomer(
  customerIds: number[],
): Promise<Map<number, ClientNoteRow[]>> {
  const byCustomer = new Map<number, ClientNoteRow[]>();
  if (customerIds.length === 0) return byCustomer;

  const notes = await prisma.customerInteraction.findMany({
    where: { customerId: { in: customerIds }, source: CLIENT_NOTE_SOURCE },
    orderBy: { startedAt: "desc" },
    select: CLIENT_NOTE_SELECT,
  });

  for (const note of notes) {
    if (note.customerId === null) continue;
    const list = byCustomer.get(note.customerId) ?? [];
    if (list.length < MAX_NOTES_PER_CLIENT) list.push(note);
    byCustomer.set(note.customerId, list);
  }
  return byCustomer;
}

/** Goods only: a product with a service type (delivery, install, measure, house call)
 *  and an order's delivery fee say nothing about what the client likes. */
function isGoodsLine(
  line: { id: number; product: { serviceType: string | null } | null },
  deliveryFeeLineItemId: number | null,
): boolean {
  return line.id !== deliveryFeeLineItemId && !line.product?.serviceType;
}

/** Each client's most recent sale. Returns are left out (not a purchase), as are
 *  cancelled lines (rule 33), 0-qty lines (rule 31) and service charges. */
export async function fetchLastPurchaseByCustomer(
  customerIds: number[],
): Promise<Map<number, LastPurchase>> {
  const byCustomer = new Map<number, LastPurchase>();
  if (customerIds.length === 0) return byCustomer;

  const orders = await prisma.salesOrder.findMany({
    where: { customerId: { in: customerIds }, status: { in: ["ORDER", "FULFILLED"] } },
    orderBy: [{ customerId: "asc" }, { orderDate: { sort: "desc", nulls: "last" } }],
    distinct: ["customerId"],
    select: {
      id: true,
      customerId: true,
      orderno: true,
      orderDate: true,
      deliveryFeeLineItemId: true,
      lineItems: {
        where: {
          netPrice: { gt: 0 },
          orderedQuantity: { gt: 0 },
          lineItemStatus: { not: "CANCELLED" },
        },
        orderBy: { netPrice: "desc" },
        select: { id: true, productName: true, product: { select: { serviceType: true } } },
      },
    },
  });

  for (const order of orders) {
    if (order.customerId === null) continue;
    const names = order.lineItems
      .filter((line) => isGoodsLine(line, order.deliveryFeeLineItemId))
      .map((line) => line.productName)
      .filter((name): name is string => Boolean(name));
    const items = [...new Set(names)].slice(0, LAST_PURCHASE_ITEM_COUNT);
    byCustomer.set(order.customerId, {
      id: order.id,
      orderno: order.orderno,
      orderDate: order.orderDate?.toISOString() ?? null,
      items,
    });
  }
  return byCustomer;
}

/** Goods only: the same lines fetchLastPurchaseByCustomer counts, with netPrice as the
 *  line total, which it is on sold orders. */
async function fetchBrandsByCustomer(customerIds: number[]): Promise<Map<number, string[]>> {
  const lines = await prisma.orderLineItem.findMany({
    where: {
      salesOrder: { customerId: { in: customerIds }, status: { in: ["ORDER", "FULFILLED"] } },
      netPrice: { gt: 0 },
      orderedQuantity: { gt: 0 },
      lineItemStatus: { not: "CANCELLED" },
      productId: { not: null },
    },
    select: {
      id: true,
      netPrice: true,
      salesOrder: { select: { customerId: true, deliveryFeeLineItemId: true } },
      product: { select: { serviceType: true, vendor: { select: { name: true } } } },
    },
  });

  const linesByCustomer = new Map<number, { vendorName: string; lineTotal: number }[]>();
  for (const line of lines) {
    const customerId = line.salesOrder.customerId;
    const vendorName = line.product?.vendor.name;
    if (customerId === null || !vendorName) continue;
    if (!isGoodsLine(line, line.salesOrder.deliveryFeeLineItemId)) continue;
    const list = linesByCustomer.get(customerId) ?? [];
    list.push({ vendorName, lineTotal: Number(line.netPrice) });
    linesByCustomer.set(customerId, list);
  }
  return new Map(
    [...linesByCustomer].map(([customerId, list]) => [customerId, topBrands(list)] as const),
  );
}

async function fetchLocationsByCustomer(customerIds: number[]): Promise<Map<number, string[]>> {
  const addresses = await prisma.customerAddress.findMany({
    where: { customerId: { in: customerIds } },
    orderBy: { id: "asc" },
    select: { customerId: true, city: true, state: true },
  });
  const byCustomer = new Map<number, { city: string; state: string }[]>();
  for (const address of addresses) {
    const list = byCustomer.get(address.customerId) ?? [];
    list.push(address);
    byCustomer.set(address.customerId, list);
  }
  return new Map(
    [...byCustomer].map(([customerId, list]) => [customerId, distinctLocations(list)] as const),
  );
}

export async function fetchClientBackground(
  customerIds: number[],
): Promise<Map<number, ClientBackground>> {
  const [lastPurchases, brands, locations] = await Promise.all([
    fetchLastPurchaseByCustomer(customerIds),
    fetchBrandsByCustomer(customerIds),
    fetchLocationsByCustomer(customerIds),
  ]);
  return new Map(
    customerIds.map((id) => [
      id,
      {
        lastPurchase: lastPurchases.get(id) ?? null,
        brands: brands.get(id) ?? [],
        locations: locations.get(id) ?? [],
      },
    ]),
  );
}
