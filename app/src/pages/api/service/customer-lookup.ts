// /app/src/pages/api/service/customer-lookup.ts
//
// Cascading lookup for customer service: customer -> orders -> line items -> vendor.
// Returns a customer's full order history with item-level detail and vendor contacts
// so service staff can quickly find what they need without cross-referencing.

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

  const customerId = Number.parseInt(req.query.customerId as string);
  if (Number.isNaN(customerId)) {
    return res.status(400).json({ error: "customerId is required" });
  }

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        addresses: { orderBy: { id: "asc" } },
        salesOrders: {
          orderBy: { orderDate: "desc" },
          include: {
            lineItems: {
              include: {
                product: {
                  select: {
                    id: true,
                    productNumber: true,
                    name: true,
                    vendor: {
                      select: {
                        id: true,
                        name: true,
                      },
                    },
                  },
                },
              },
            },
            payments: {
              select: {
                id: true,
                paymentAmount: true,
                paymentType: true,
                paymentDate: true,
              },
              orderBy: { paymentDate: "desc" },
            },
          },
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // Transform to safe JSON (convert Decimals)
    const result = {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      creditBalance: Number(customer.creditBalance),
      addresses: customer.addresses,
      orders: customer.salesOrders.map((order) => {
        const totalDue = order.lineItems.reduce(
          (sum, li) => sum + Number(li.netPrice || 0) + Number(li.vatAmount || 0),
          0,
        );
        const totalPaid = order.payments.reduce((sum, p) => sum + Number(p.paymentAmount || 0), 0);

        return {
          id: order.id,
          orderno: order.orderno,
          orderDate: order.orderDate,
          storeLocation: order.storeLocation,
          dispatchStatus: order.dispatchStatus,
          totalDue: Math.round(totalDue * 100) / 100,
          totalPaid: Math.round(totalPaid * 100) / 100,
          balanceDue: Math.round((totalDue - totalPaid) * 100) / 100,
          lineItems: order.lineItems.map((li) => ({
            id: li.id,
            partNo: li.partNo,
            productName: li.productName,
            quantity: Number(li.orderedQuantity),
            netPrice: Number(li.netPrice),
            product: li.product
              ? {
                  id: li.product.id,
                  productNumber: li.product.productNumber,
                  name: li.product.name,
                  vendor: li.product.vendor,
                }
              : null,
          })),
        };
      }),
    };

    return res.status(200).json(result);
  } catch (error) {
    logError("Customer lookup error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
