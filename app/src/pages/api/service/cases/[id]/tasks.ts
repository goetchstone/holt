// /app/src/pages/api/service/cases/[id]/tasks.ts
//
// A service case's tasks: list them (GET) and add one (POST, from the case
// page). Both are "Work service" (service.write), like the case, notes,
// checklist and task routes beside it. Register and Marketing hold no service
// key and are refused, as on the rest of the case's data (cases/[id]/index.ts).

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import {
  success,
  created,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const caseId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(caseId)) return badRequest(res, "Invalid case ID");

  const taskInclude = {
    assignedTo: { select: { id: true, displayName: true } },
    linkedOrder: { select: { id: true, orderno: true } },
    linkedPurchaseOrder: { select: { id: true, poNumber: true } },
  };

  if (req.method === "GET") {
    try {
      const tasks = await prisma.serviceTask.findMany({
        where: { caseId },
        include: taskInclude,
        // A checklist's tasks share a created time; the id keeps step order.
        orderBy: [{ created: "asc" }, { id: "asc" }],
      });
      return success(res, tasks);
    } catch (err) {
      return handleError(res, err, "GET /service/cases/[id]/tasks");
    }
  }

  if (req.method === "POST") {
    const {
      title,
      description,
      assignedToId,
      waitingOn,
      dueDate,
      linkedOrderId,
      linkedPurchaseOrderId,
    } = req.body;
    if (!title?.trim()) return badRequest(res, "Title is required");

    try {
      const task = await prisma.serviceTask.create({
        data: {
          caseId,
          title: title.trim(),
          description: description || null,
          assignedToId: assignedToId || null,
          waitingOn: waitingOn || null,
          dueDate: dueDate ? new Date(dueDate) : null,
          linkedOrderId: linkedOrderId || null,
          linkedPurchaseOrderId: linkedPurchaseOrderId || null,
          createdBy: session.user?.email || null,
        },
        include: taskInclude,
      });
      return created(res, task);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2003") return notFound(res, "Case");
      return handleError(res, err, "POST /service/cases/[id]/tasks");
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}

export default requirePermission("service.write", handler);
