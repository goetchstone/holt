// /app/src/pages/api/print/order/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Order ID is required." });
  }

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: Number.parseInt(id) },
      include: {
        customer: {
          include: { addresses: true },
        },
        lineItems: { include: { product: true } },
        invoices: { include: { lineItems: { include: { orderLineItem: true } } } },
        payments: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    // Look up store address from StoreLocation if the order has a storeLocation string
    let storeAddress: {
      name: string;
      address: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    } | null = null;

    if (order.storeLocation) {
      const location = await prisma.storeLocation.findFirst({
        where: {
          OR: [{ name: order.storeLocation }, { externalLocationName: order.storeLocation }],
        },
      });
      if (location) {
        storeAddress = {
          name: location.name,
          address: location.address,
          city: location.city,
          state: location.state,
          zip: location.zip,
        };
      }
    }

    return res.status(200).json({
      id: order.id,
      orderno: order.orderno,
      orderDate: order.orderDate,
      status: order.status,
      salesperson: order.salesperson,
      storeLocation: order.storeLocation,
      storeAddress,
      orderNotes: order.orderNotes,
      customer: order.customer
        ? {
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
            email: order.customer.email,
            phone: order.customer.phone,
            addresses: order.customer.addresses.map((a) => ({
              id: a.id,
              label: a.label,
              address1: a.address1,
              address2: a.address2,
              city: a.city,
              state: a.state,
              zip: a.zip,
            })),
          }
        : null,
      lineItems: order.lineItems.map((item) => ({
        id: item.id,
        productName: item.productName,
        partNo: item.partNo,
        barcode: item.barcode,
        description: item.product?.description || null,
        selectedGrade: item.selectedGrade || null,
        selectedOptions: item.selectedOptions || null,
        orderedQuantity: Number(item.orderedQuantity),
        netPrice: Number(item.netPrice),
        vatRate: item.vatRate != null ? Number(item.vatRate) : null,
        vatAmount: item.vatAmount != null ? Number(item.vatAmount) : null,
      })),
      invoices: order.invoices.map((inv) => ({
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        taxAmount: Number(inv.taxAmount),
        lineItems: inv.lineItems.map((li) => ({
          id: li.id,
          deliveredQuantity: Number(li.deliveredQuantity),
          orderLineItem: { partNo: li.orderLineItem.partNo },
        })),
      })),
      payments: order.payments.map((p) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        paymentType: p.paymentType,
        paymentAmount: Number(p.paymentAmount),
      })),
    });
  } catch (error) {
    logError("Error fetching order for print", error);
    return res.status(500).json({ error: "Failed to fetch order details." });
  }
}
