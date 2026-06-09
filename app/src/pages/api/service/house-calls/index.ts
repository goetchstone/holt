// /app/src/pages/api/service/house-calls/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { generateAppointmentNumber } from "@/lib/serviceDispatchService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const page = Number.parseInt(req.query.page as string) || 1;
  const limit = Number.parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string | undefined;
  const designerId = req.query.designerId as string | undefined;
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  const where: any = { type: "HOUSE_CALL" };

  if (status) {
    where.status = status;
  }

  if (designerId) {
    where.designerId = Number.parseInt(designerId);
  }

  if (dateFrom || dateTo) {
    where.scheduledDate = {};
    if (dateFrom) where.scheduledDate.gte = new Date(dateFrom);
    if (dateTo) where.scheduledDate.lte = new Date(dateTo);
  }

  try {
    const [appointments, total] = await Promise.all([
      prisma.serviceAppointment.findMany({
        where,
        include: {
          salesOrder: { select: { orderno: true } },
          customer: { select: { firstName: true, lastName: true } },
          designer: { select: { displayName: true } },
          address: true,
          storeLocation: { select: { name: true } },
        },
        orderBy: { scheduledDate: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.serviceAppointment.count({ where }),
    ]);

    const houseCalls = appointments.map((a) => ({
      id: a.id,
      appointmentNumber: a.appointmentNumber,
      customerName: a.customer ? `${a.customer.firstName} ${a.customer.lastName}`.trim() : "",
      designerName: a.designer?.displayName || null,
      scheduledDate: a.scheduledDate,
      scheduledTime: a.scheduledTime,
      duration: a.estimatedDuration,
      storeName: a.storeLocation?.name || null,
      scope: a.scopeOfWork,
      status: a.status,
    }));

    return res.status(200).json({ houseCalls, total });
  } catch (error) {
    logError("Error fetching house calls", error);
    return res.status(500).json({ error: "Failed to fetch house calls" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const {
    customerId,
    addressId,
    address,
    scheduledDate,
    scheduledTime,
    duration,
    designerId,
    locationId,
    scope,
    specialInstructions,
    orderId,
  } = req.body;

  if (!customerId) {
    return res.status(400).json({ error: "customerId is required" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let salesOrderId = orderId ? Number.parseInt(orderId) : null;

      // Resolve designer display name for the sales order salesperson field
      let designerDisplayName: string | null = null;
      if (designerId) {
        const designer = await tx.staffMember.findUnique({
          where: { id: Number.parseInt(designerId) },
          select: { displayName: true },
        });
        designerDisplayName = designer?.displayName || null;
      }

      // Auto-create a sales order with DC250 house call product if no order provided
      if (!salesOrderId) {
        const houseCallProduct = await tx.product.findFirst({
          where: { serviceType: "HOUSE_CALL" },
        });

        // Generate order number: HC-YYMMDD-NNN
        const now = new Date();
        const yy = now.getFullYear().toString().slice(-2);
        const mm = (now.getMonth() + 1).toString().padStart(2, "0");
        const dd = now.getDate().toString().padStart(2, "0");
        const prefix = `HC-${yy}${mm}${dd}-`;
        const lastOrder = await tx.salesOrder.findFirst({
          where: { orderno: { startsWith: prefix } },
          orderBy: { orderno: "desc" },
          select: { orderno: true },
        });
        let seq = 1;
        if (lastOrder) {
          const lastSeq = Number.parseInt(lastOrder.orderno.replace(prefix, ""), 10);
          if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
        }
        const orderno = `${prefix}${seq.toString().padStart(3, "0")}`;

        const order = await tx.salesOrder.create({
          data: {
            orderno,
            orderDate: now,
            status: "QUOTE",
            customerId: Number.parseInt(customerId),
            salesperson: designerDisplayName || undefined,
            storeLocationId: locationId ? Number.parseInt(locationId) : undefined,
            createdBy,
          },
        });
        salesOrderId = order.id;

        // Add house call product as line item if it exists
        if (houseCallProduct) {
          await tx.orderLineItem.create({
            data: {
              salesOrderId: order.id,
              lineNumber: 1,
              productId: houseCallProduct.id,
              productName: houseCallProduct.name || "House Call",
              partNo: houseCallProduct.productNumber || "DC250",
              orderedQuantity: 1,
              netPrice: houseCallProduct.baseRetail || 0,
              cost: houseCallProduct.baseCost || 0,
            },
          });
        }
      }

      // Create or resolve address
      let resolvedAddressId: number | undefined;
      if (addressId) {
        resolvedAddressId = Number.parseInt(addressId);
      } else if (address && address.street) {
        const newAddr = await tx.customerAddress.create({
          data: {
            customerId: Number.parseInt(customerId),
            address1: address.street,
            city: address.city || "",
            state: address.state || "",
            zip: address.zip || "",
          },
        });
        resolvedAddressId = newAddr.id;
      }

      const appointmentNumber = await generateAppointmentNumber();

      const appointment = await tx.serviceAppointment.create({
        data: {
          appointmentNumber,
          type: "HOUSE_CALL",
          status: scheduledDate ? "SCHEDULED" : "PENDING",
          salesOrderId,
          customerId: Number.parseInt(customerId),
          addressId: resolvedAddressId,
          scheduledDate: scheduledDate ? new Date(scheduledDate) : undefined,
          scheduledTime: scheduledTime || undefined,
          estimatedDuration: duration ? Number.parseFloat(duration) : undefined,
          designerId: designerId ? Number.parseInt(designerId) : undefined,
          storeLocationId: locationId ? Number.parseInt(locationId) : undefined,
          scopeOfWork: scope || undefined,
          notes: specialInstructions || undefined,
          createdBy,
        },
      });

      return appointment;
    });

    return res.status(201).json(result);
  } catch (error) {
    logError("Error creating house call", error);
    return res.status(500).json({ error: "Failed to create house call" });
  }
}
