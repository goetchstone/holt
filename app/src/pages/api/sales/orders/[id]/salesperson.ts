// /app/src/pages/api/sales/orders/[id]/salesperson.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import {
  success,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";
import { assertReassignAllowed, AttributionLockedError } from "@/lib/payPeriodLockGuard";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return unauthorized(res);

  if (req.method !== "PUT") return methodNotAllowed(res, ["PUT"]);

  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return forbidden(res, "Manager role required to change salesperson");
  }

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  const { salesPersonId, splitWithId } = req.body;

  if (salesPersonId === undefined) {
    return badRequest(res, "salesPersonId is required");
  }

  if (salesPersonId !== null && typeof salesPersonId !== "number") {
    return badRequest(res, "salesPersonId must be a number or null");
  }

  if (splitWithId !== undefined && splitWithId !== null && typeof splitWithId !== "number") {
    return badRequest(res, "splitWithId must be a number or null");
  }

  if (salesPersonId !== null && splitWithId === salesPersonId) {
    return badRequest(res, "Split salesperson must be different from primary salesperson");
  }

  try {
    const order = await prisma.salesOrder.findUnique({ where: { id: orderId } });
    if (!order) return notFound(res, "Order");

    // Pay-period lock: refuse if the order's date sits in a confirmed
    // period for either the current OR the target designer.
    try {
      await assertReassignAllowed({
        orderDate: order.orderDate,
        currentDesignerIds: [order.salesPersonId, order.splitWithId],
        targetDesignerIds: [salesPersonId, splitWithId ?? null],
      });
    } catch (lockErr) {
      if (lockErr instanceof AttributionLockedError) {
        return res.status(409).json({ error: lockErr.message });
      }
      throw lockErr;
    }

    // Validate staff members exist and are active
    if (salesPersonId !== null) {
      const primary = await prisma.staffMember.findUnique({ where: { id: salesPersonId } });
      if (!primary) return badRequest(res, "Primary salesperson not found");
      if (!primary.isActive) return badRequest(res, "Primary salesperson is not active");
    }

    const resolvedSplitWithId = splitWithId ?? null;
    if (resolvedSplitWithId !== null) {
      const splitStaff = await prisma.staffMember.findUnique({
        where: { id: resolvedSplitWithId },
      });
      if (!splitStaff) return badRequest(res, "Split salesperson not found");
      if (!splitStaff.isActive) return badRequest(res, "Split salesperson is not active");
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Look up the new primary salesperson name for the legacy string field
      let salespersonName = order.salesperson;
      if (salesPersonId !== null) {
        const staff = await tx.staffMember.findUnique({ where: { id: salesPersonId } });
        salespersonName = staff?.displayName ?? null;
      } else {
        salespersonName = null;
      }

      const result = await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          salesPersonId,
          salesperson: salespersonName,
          splitWithId: resolvedSplitWithId,
          updatedBy: session.user!.email,
        },
        include: {
          salesPerson: { select: { id: true, displayName: true } },
          splitWith: { select: { id: true, displayName: true } },
        },
      });

      // Build change log description
      const changes: string[] = [];
      if (order.salesPersonId !== salesPersonId) {
        const oldName = order.salesperson || "none";
        const newName = salespersonName || "none";
        changes.push(`${oldName} -> ${newName}`);
      }
      if (order.splitWithId !== resolvedSplitWithId) {
        const oldSplit = order.splitWithId ? `staff #${order.splitWithId}` : "none";
        const newSplit = result.splitWith?.displayName || "none";
        changes.push(`split: ${oldSplit} -> ${newSplit}`);
      }

      if (changes.length > 0) {
        await tx.orderChangeLog.create({
          data: {
            salesOrderId: orderId,
            changeType: "SALESPERSON_CHANGE",
            previousValue: [
              order.salesperson || "none",
              order.splitWithId ? `split #${order.splitWithId}` : null,
            ]
              .filter(Boolean)
              .join(", "),
            newValue: [
              salespersonName || "none",
              resolvedSplitWithId ? `split with ${result.splitWith?.displayName}` : null,
            ]
              .filter(Boolean)
              .join(", "),
            changedBy: session.user!.email,
          },
        });
      }

      return result;
    });

    return success(res, {
      id: updated.id,
      salesPersonId: updated.salesPersonId,
      salesPerson: updated.salesPerson,
      splitWithId: updated.splitWithId,
      splitWith: updated.splitWith,
      salesperson: updated.salesperson,
    });
  } catch (err) {
    return handleError(res, err, "PUT /sales/orders/[id]/salesperson");
  }
}
