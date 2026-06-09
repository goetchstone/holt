// /app/src/pages/api/service/cases/[id]/tasks.ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  created,
  unauthorized,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

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
        orderBy: { created: "asc" },
      });
      return success(res, tasks);
    } catch (err) {
      return handleError(res, err, "GET /service/cases/[id]/tasks");
    }
  }

  if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

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
