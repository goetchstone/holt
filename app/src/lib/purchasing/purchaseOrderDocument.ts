// /app/src/lib/purchasing/purchaseOrderDocument.ts
//
// GAP-01: one purchase order as a document for its vendor -- the PDF the PO
// screen prints, and the same PDF attached when it is emailed. One loader for
// both, so the printed copy and the emailed copy can't differ.
//
// Zero-quantity lines are cancelled lines (rule 31) and are left off: the
// vendor is not asked for them.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { poLineTotal } from "@/lib/purchasing/purchaseOrderShared";
import {
  generatePurchaseOrderPdf,
  type PurchaseOrderPdfParty,
} from "@/lib/purchasing/purchaseOrderPdf";
import { PurchaseOrderError } from "@/lib/purchasing/stockPurchaseOrder";

export interface PurchaseOrderDocument {
  poNumber: string;
  status: string;
  vendorName: string;
  /** Where the PO is emailed unless the sender says otherwise: the vendor's
   *  address, else its primary contact's. Null when neither is recorded. */
  vendorEmail: string | null;
  companyName: string;
  pdf: Buffer;
  filename: string;
}

const joined = (...parts: (string | null | undefined)[]) =>
  parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");

function address(a: {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string[] {
  const cityLine = joined(a.city, [a.state, a.zip].filter(Boolean).join(" "));
  return [a.address?.trim(), cityLine].filter((l): l is string => Boolean(l));
}

/** The PO's PDF and what an email of it needs. Cost only when `showCost`. */
export async function purchaseOrderDocument(
  poId: number,
  showCost: boolean,
): Promise<PurchaseOrderDocument> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      poNumber: true,
      status: true,
      orderDate: true,
      expectedDelivery: true,
      notes: true,
      vendor: {
        select: {
          name: true,
          address: true,
          city: true,
          state: true,
          zip: true,
          phone: true,
          email: true,
          accountNumber: true,
          paymentTerms: true,
          freightTerms: true,
          contacts: {
            where: { email: { not: null } },
            orderBy: [{ isPrimary: "desc" }, { id: "asc" }],
            take: 1,
            select: { email: true },
          },
        },
      },
      shipTo: { select: { name: true, address: true, city: true, state: true, zip: true } },
      lineItems: {
        where: { orderedQuantity: { gt: 0 } },
        orderBy: { id: "asc" },
        select: {
          partNo: true,
          productName: true,
          orderedQuantity: true,
          unitCost: true,
          product: { select: { productNumber: true, name: true } },
        },
      },
    },
  });
  if (!po) throw new PurchaseOrderError("Purchase order not found.", 404);

  const settings = await getAppSettings();
  const locale = settings.locale || "en-US";
  const money = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: settings.currency || "USD",
  });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: settings.timezone });
  // The expected date is a calendar day stored at UTC midnight.
  const calendarDay = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" });
  const companyName = settings.companyName?.trim() || settings.appName;

  const v = po.vendor;
  const vendor: PurchaseOrderPdfParty = {
    name: v.name,
    lines: [
      ...address(v),
      ...(v.phone?.trim() ? [v.phone.trim()] : []),
      ...(v.accountNumber?.trim() ? [`Our account: ${v.accountNumber.trim()}`] : []),
    ],
  };
  const amounts = po.lineItems.map((l) =>
    poLineTotal(Number(l.orderedQuantity), Number(l.unitCost)),
  );
  const lines = po.lineItems.map((l, i) => ({
    partNo: l.product?.productNumber ?? l.partNo ?? "",
    description: l.product?.name ?? l.productName ?? "",
    quantity: String(Number(l.orderedQuantity)),
    unitCost: showCost ? money.format(Number(l.unitCost)) : null,
    amount: showCost ? money.format(amounts[i]) : null,
  }));
  const total = amounts.reduce((sum, a) => sum + a, 0);

  const pdf = generatePurchaseOrderPdf(
    {
      poNumber: po.poNumber,
      orderDate: day.format(po.orderDate),
      expectedDelivery: po.expectedDelivery ? calendarDay.format(po.expectedDelivery) : null,
      vendor,
      shipTo: po.shipTo ? { name: po.shipTo.name, lines: address(po.shipTo) } : null,
      terms: [
        ...(v.paymentTerms?.trim() ? [`Payment terms: ${v.paymentTerms.trim()}`] : []),
        ...(v.freightTerms?.trim() ? [`Freight: ${v.freightTerms.trim()}`] : []),
      ],
      notes: po.notes,
      lines,
      total: showCost ? money.format(Math.round(total * 100) / 100) : null,
    },
    {
      companyName,
      navy: settings.theme.navy,
      gold: settings.theme.gold,
      gray: settings.theme.gray,
    },
  );

  return {
    poNumber: po.poNumber,
    status: po.status,
    vendorName: v.name,
    vendorEmail: v.email?.trim() || v.contacts[0]?.email?.trim() || null,
    companyName,
    pdf,
    // An imported PO number can hold anything; the header gets a safe name.
    filename: `${po.poNumber.replace(/[^\w.-]+/g, "_")}.pdf`,
  };
}
