// /app/src/pages/api/service/tasks/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import {
  success,
  noContent,
  unauthorized,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

const taskInclude = {
  assignedTo: { select: { id: true, displayName: true } },
  linkedOrder: { select: { id: true, orderno: true } },
  linkedPurchaseOrder: { select: { id: true, poNumber: true } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return badRequest(res, "Invalid task ID");

  if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    const {
      title,
      description,
      status,
      assignedToId,
      waitingOn,
      dueDate,
      linkedOrderId,
      linkedPurchaseOrderId,
    } = req.body;

    try {
      const existing = await prisma.serviceTask.findUnique({
        where: { id },
        select: { status: true },
      });

      if (!existing) return notFound(res, "Task");

      const data: Record<string, unknown> = {
        updatedBy: session.user?.email || null,
      };

      if (title !== undefined) data.title = title.trim();
      if (description !== undefined) data.description = description || null;
      if (assignedToId !== undefined) data.assignedToId = assignedToId || null;
      if (waitingOn !== undefined) data.waitingOn = waitingOn || null;
      if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
      if (linkedOrderId !== undefined) data.linkedOrderId = linkedOrderId || null;
      if (linkedPurchaseOrderId !== undefined) {
        data.linkedPurchaseOrderId = linkedPurchaseOrderId || null;
      }

      if (status !== undefined) {
        data.status = status;
        if (status === "COMPLETED" && existing.status !== "COMPLETED") {
          data.completedAt = new Date();
        } else if (status !== "COMPLETED" && existing.status === "COMPLETED") {
          data.completedAt = null;
        }
      }

      const task = await prisma.serviceTask.update({
        where: { id },
        data,
        include: taskInclude,
      });

      return success(res, task);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Task");
      return handleError(res, err, "PUT /service/tasks/[id]");
    }
  }

  if (req.method === "DELETE") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    try {
      await prisma.serviceTask.delete({ where: { id } });
      return noContent(res);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") return notFound(res, "Task");
      return handleError(res, err, "DELETE /service/tasks/[id]");
    }
  }

  return methodNotAllowed(res, ["PUT", "DELETE"]);
}
