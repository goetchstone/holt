// /app/src/pages/api/service/cases/[id]/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

// Service cases span the delivery/install/designer/warehouse workflow.
// Register and Marketing have no legitimate reason to read or mutate
// service case data, so they're excluded.
export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const id = Number.parseInt(req.query.id as string);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid case ID" });

    if (req.method === "GET") {
      try {
        const serviceCase = await prisma.serviceCase.findUnique({
          where: { id },
          include: {
            type: true,
            status: true,
            priority: true,
            customer: {
              select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            },
            salesOrder: {
              select: {
                id: true,
                orderno: true,
                orderDate: true,
                dispatchStatus: true,
                lineItems: {
                  select: { id: true, productName: true, partNo: true, netPrice: true },
                },
              },
            },
            purchaseOrder: {
              select: {
                id: true,
                poNumber: true,
                status: true,
                orderDate: true,
                expectedDelivery: true,
              },
            },
            vendor: { select: { id: true, name: true, phone: true, email: true } },
            assignedTo: { select: { id: true, displayName: true } },
            salesPerson: { select: { id: true, displayName: true } },
            notes: {
              orderBy: { created: "asc" },
              include: { author: { select: { id: true, displayName: true } } },
            },
            tasks: {
              include: {
                assignedTo: { select: { id: true, displayName: true } },
                linkedOrder: { select: { id: true, orderno: true } },
                linkedPurchaseOrder: { select: { id: true, poNumber: true } },
              },
            },
            emails: true,
          },
        });

        if (!serviceCase) {
          return res.status(404).json({ error: "Case not found" });
        }

        const result = {
          ...serviceCase,
          salesOrder: serviceCase.salesOrder
            ? {
                ...serviceCase.salesOrder,
                lineItems: serviceCase.salesOrder.lineItems.map((li) => ({
                  ...li,
                  netPrice: Number(li.netPrice),
                })),
              }
            : null,
        };

        return res.status(200).json(result);
      } catch (err) {
        logError("GET /service/cases/[id] failed", err, { id });
        return res.status(500).json({ error: "Internal server error" });
      }
    }

    if (req.method === "PUT") {
      const {
        typeId,
        statusId,
        priorityId,
        summary,
        customerId,
        salesOrderId,
        vendorId,
        salesPersonId,
        assignedToId,
        storeLocation,
        preferredContact,
        itemDescription,
        partNo,
        resolutionNotes,
      } = req.body;

      try {
        const data: Record<string, unknown> = {
          updatedBy: session.user?.email || null,
        };

        if (typeId !== undefined) data.typeId = typeId;
        if (priorityId !== undefined) data.priorityId = priorityId;
        if (summary !== undefined) data.summary = summary.trim();
        if (customerId !== undefined) data.customerId = customerId || null;
        if (salesOrderId !== undefined) data.salesOrderId = salesOrderId || null;
        if (vendorId !== undefined) data.vendorId = vendorId || null;
        if (salesPersonId !== undefined) data.salesPersonId = salesPersonId || null;
        if (assignedToId !== undefined) data.assignedToId = assignedToId || null;
        if (storeLocation !== undefined) data.storeLocation = storeLocation || null;
        if (preferredContact !== undefined) data.preferredContact = preferredContact || null;
        if (itemDescription !== undefined) data.itemDescription = itemDescription || null;
        if (partNo !== undefined) data.partNo = partNo || null;
        if (resolutionNotes !== undefined) data.resolutionNotes = resolutionNotes || null;

        if (statusId !== undefined) {
          data.statusId = statusId;
          const newStatus = await prisma.serviceCaseStatus.findUnique({
            where: { id: statusId },
            select: { isClosed: true },
          });
          if (newStatus?.isClosed) {
            data.resolvedAt = new Date();
          }
        }

        const updated = await prisma.serviceCase.update({
          where: { id },
          data,
          include: {
            type: { select: { id: true, name: true } },
            status: { select: { id: true, name: true, isClosed: true, color: true } },
            priority: { select: { id: true, name: true, color: true } },
            customer: { select: { id: true, firstName: true, lastName: true } },
            assignedTo: { select: { id: true, displayName: true } },
          },
        });

        return res.status(200).json(updated);
      } catch (err) {
        if (err instanceof Error && (err as { code?: string }).code === "P2025") {
          return res.status(404).json({ error: "Case not found" });
        }
        logError("PUT /service/cases/[id] failed", err, { id });
        return res.status(500).json({ error: "Failed to update case" });
      }
    }

    res.setHeader("Allow", ["GET", "PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  },
);
