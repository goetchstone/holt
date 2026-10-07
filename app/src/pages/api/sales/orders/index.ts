// /app/src/pages/api/sales/orders/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 10;
    const search = (req.query.search as string)?.trim() || "";

    const skip = (page - 1) * limit;

    const statusFilter = req.query.status as string | undefined;
    const salespersonFilter = (req.query.salesperson as string)?.trim() || "";

    // Multi-token search: ""ORD-100 John"" matches orderno starting with the prefix AND customer John.
    const searchFilter = buildSearchFilter(search, [
      "orderno",
      "customer.firstName",
      "customer.lastName",
      "salesperson",
    ]);
    const where: Prisma.SalesOrderWhereInput = (searchFilter ?? {}) as Prisma.SalesOrderWhereInput;
    if (statusFilter) {
      where.status = statusFilter as Prisma.EnumSalesOrderStatusFilter;
    }
    if (salespersonFilter) {
      where.salesperson = { contains: salespersonFilter, mode: "insensitive" };
    }

    const storeFilter = (req.query.store as string)?.trim() || "";
    if (storeFilter) {
      where.storeLocation = { contains: storeFilter, mode: "insensitive" };
    }

    const fromFilter = req.query.from as string | undefined;
    const toFilter = req.query.to as string | undefined;
    if (fromFilter || toFilter) {
      where.orderDate = {};
      if (fromFilter) where.orderDate.gte = new Date(fromFilter);
      if (toFilter) {
        const toDate = new Date(toFilter);
        toDate.setDate(toDate.getDate() + 1);
        where.orderDate.lt = toDate;
      }
    }

    const [salesOrders, total] = await Promise.all([
      prisma.salesOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { orderDate: "desc" },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
          lineItems: true,
          invoices: true,
          payments: true,
        },
      }),
      prisma.salesOrder.count({ where }),
    ]);

    const ordersWithTotals = salesOrders.map((order) => {
      // Calculate total paid
      const totalPaid = order.payments.reduce((sum, p) => sum + (Number(p.paymentAmount) || 0), 0);

      // Calculate total net sales from line items
      const totalNetSales = order.lineItems.reduce(
        (sum, item) => sum + (Number(item.netPrice) || 0),
        0,
      );

      const totalTax = order.lineItems.reduce(
        (sum, item) => sum + (Number(item.vatAmount) || 0),
        0,
      );

      // Calculate total amount (net sales + tax)
      const totalAmount = totalNetSales + totalTax;

      const customerName =
        [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ") || null;

      return {
        id: order.id,
        orderno: order.orderno,
        orderDate: order.orderDate,
        salesperson: order.salesperson,
        salesPersonId: order.salesPersonId,
        splitWithId: order.splitWithId,
        storeLocation: order.storeLocation,
        status: order.status,
        dispatchStatus: order.dispatchStatus,
        customer: order.customer,
        customerName,
        totalPaid,
        totalTax,
        totalAmount,
      };
    });

    return res.status(200).json({ orders: ordersWithTotals, total });
  } catch (error) {
    logError("Error fetching sales orders", error);
    return res.status(500).json({ error: "Failed to fetch sales orders" });
  }
}

// GET-only order list. The write half of this family (./[id].ts, line-items,
// dispatch, create-from-cart) is `sales.write`; the read half is `sales.read` —
// verbatim "See quotes, orders and proposals", and the key the Sales nav entry
// is derived from. Not sales.write: warehouse and installer staff hold only the
// read grant and reach this list through the service-case and return screens
// that look an order up.
export default requirePermission("sales.read", handler);
