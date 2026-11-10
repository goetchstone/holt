// /app/src/lib/purchasing/dropShip.ts
//
// Drop ship (GAP-20, DECISIONS 55). Owner, 2026-11-05: "as easy as putting that on the
// po if the vendor allows for it". A vendor set to drop ship (Vendor.dropShips) can be
// sent a sale's PO with the customer's address as ship-to (PurchaseOrder.
// dropShipAddressId). Owner, 2026-11-10: receiving it hands those lines over, "once
// received we assume the customer has it". So its lines take no store stock while they
// wait (lib/inventory/orderInventorySync.ts), and receiving records the goods without
// stocking them, then hands the lines over (lib/fulfilment/handover.ts deliverDropShipped).

import type { Prisma } from "@prisma/client";

type Db = Pick<Prisma.TransactionClient, "purchaseOrder" | "salesOrder">;

export interface DropShipTarget {
  salesOrderId: number;
  addressId: number;
  /** Who and where, as the editor offers it. */
  label: string;
}

export type DropShipCheck = { ok: true; target: DropShipTarget } | { ok: false; problem: string };

export function addressLines(a: {
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
}): string[] {
  return [a.address1, ...(a.address2 ? [a.address2] : []), `${a.city}, ${a.state} ${a.zip}`];
}

export function customerName(c: { firstName: string | null; lastName: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "The customer";
}

/** Why a customer's address can't be deleted, or null: a vendor is drop shipping to it. */
export async function addressInUseProblem(
  db: Pick<Prisma.TransactionClient, "purchaseOrder">,
  addressId: number,
): Promise<string | null> {
  const shipping = await db.purchaseOrder.findFirst({
    where: { dropShipAddressId: addressId },
    select: { poNumber: true },
  });
  return shipping ? `${shipping.poNumber} ships to this address, so it can't be deleted.` : null;
}

/**
 * Where this PO could ship to the customer, or why it can't. Every line has to be for
 * one sale, since a PO has one ship-to, and the customer needs an address: the sale's
 * delivery address, or else their first one, as dispatch reads it.
 */
export async function dropShipTarget(db: Db, poId: number): Promise<DropShipCheck> {
  const po = await db.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      salesOrderId: true,
      isReturn: true,
      vendor: { select: { name: true, dropShips: true } },
      lineItems: {
        where: { orderedQuantity: { gt: 0 } },
        select: { orderLineItem: { select: { salesOrderId: true } } },
      },
    },
  });
  if (!po) return { ok: false, problem: "Purchase order not found." };
  if (!po.vendor.dropShips) {
    return {
      ok: false,
      problem: `${po.vendor.name} isn't set to drop ship. Turn it on for the vendor first.`,
    };
  }
  if (po.isReturn) return { ok: false, problem: "A return to the vendor can't be drop shipped." };
  if (po.lineItems.some((l) => !l.orderLineItem)) {
    return {
      ok: false,
      problem: "Every line has to be for the customer's sale, and this PO has stock lines too.",
    };
  }
  const sales = new Set(po.lineItems.map((l) => l.orderLineItem!.salesOrderId));
  if (po.salesOrderId !== null) sales.add(po.salesOrderId);
  if (sales.size !== 1) {
    return {
      ok: false,
      problem: "This PO has lines for more than one sale, so it can't go to one customer.",
    };
  }
  const [salesOrderId] = [...sales];
  const sale = await db.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      status: true,
      deliveryAddress: true,
      customer: {
        select: {
          firstName: true,
          lastName: true,
          addresses: { orderBy: { id: "asc" }, take: 1 },
        },
      },
    },
  });
  if (!sale || sale.status === "CANCELLED") {
    return { ok: false, problem: "The sale this PO is for is cancelled." };
  }
  const address = sale.deliveryAddress ?? sale.customer?.addresses[0];
  if (!sale.customer || !address) {
    return {
      ok: false,
      problem: "The customer has no address on file. Add one to their record first.",
    };
  }
  return {
    ok: true,
    target: {
      salesOrderId,
      addressId: address.id,
      label: [customerName(sale.customer), ...addressLines(address)].join(", "),
    },
  };
}
