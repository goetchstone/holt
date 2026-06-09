// /app/src/pages/api/service/cases/index.ts

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { computeLastActionAt, summarizeNoteText } from "@/lib/serviceCaseLastAction";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 20;
      const search = (req.query.search as string)?.trim() || "";
      const statusId = req.query.statusId
        ? Number.parseInt(req.query.statusId as string)
        : undefined;
      const typeId = req.query.typeId ? Number.parseInt(req.query.typeId as string) : undefined;
      const priorityId = req.query.priorityId
        ? Number.parseInt(req.query.priorityId as string)
        : undefined;
      const assignedToId = req.query.assignedToId
        ? Number.parseInt(req.query.assignedToId as string)
        : undefined;
      const vendorId = req.query.vendorId
        ? Number.parseInt(req.query.vendorId as string)
        : undefined;
      const storeLocation = (req.query.storeLocation as string) || undefined;
      const isClosed = req.query.isClosed !== undefined ? req.query.isClosed === "true" : undefined;

      const skip = (page - 1) * limit;

      const searchFilter = buildSearchFilter(search, [
        "caseNumber",
        "customer.firstName",
        "customer.lastName",
        "salesOrder.orderno",
      ]);

      const where: Prisma.ServiceCaseWhereInput = (searchFilter ??
        {}) as Prisma.ServiceCaseWhereInput;
      if (statusId) where.statusId = statusId;
      if (typeId) where.typeId = typeId;
      if (priorityId) where.priorityId = priorityId;
      if (assignedToId) where.assignedToId = assignedToId;
      if (vendorId) where.vendorId = vendorId;
      if (storeLocation) where.storeLocation = storeLocation;
      if (isClosed !== undefined) {
        where.status = { isClosed };
      }

      const [cases, total] = await Promise.all([
        prisma.serviceCase.findMany({
          where,
          include: {
            type: { select: { id: true, name: true } },
            status: { select: { id: true, name: true, isClosed: true, color: true } },
            priority: { select: { id: true, name: true, color: true } },
            customer: { select: { id: true, firstName: true, lastName: true } },
            salesOrder: { select: { id: true, orderno: true } },
            vendor: { select: { id: true, name: true } },
            assignedTo: { select: { id: true, displayName: true } },
            salesPerson: { select: { id: true, displayName: true } },
            // Pull the latest note's timestamp + text so the list view
            // can show "last action" relative time AND a one-line preview
            // of the most recent comment, both without N+1 queries.
            // `case.updated` alone is stale because note writes don't
            // bump the parent row's @updatedAt.
            notes: {
              orderBy: { created: "desc" },
              take: 1,
              select: { created: true, note: true, authorDisplayName: true },
            },
          },
          skip,
          take: limit,
          orderBy: { created: "desc" },
        }),
        prisma.serviceCase.count({ where }),
      ]);

      // Compute lastActionAt via the pure helper so the logic stays
      // testable and intentional. See `lib/serviceCaseLastAction.ts`
      // for why `case.updated` is excluded.
      // Also include `lastActionText` — a truncated one-line preview
      // of the most recent comment (or null when the case has no notes
      // and the only "action" was the case opening itself). Origin:
      // owner direction 2026-05-28 — "maybe we see the last comment
      // on the cases page too?"
      const casesWithLastAction = cases.map((c) => {
        const latestNote = c.notes[0];
        const lastActionAt = computeLastActionAt({
          caseCreated: c.created,
          latestNoteCreated: latestNote?.created ?? null,
        });
        const lastActionText = summarizeNoteText(latestNote?.note);
        const lastActionAuthor = latestNote?.authorDisplayName ?? null;
        const { notes: _notes, ...rest } = c;
        return { ...rest, lastActionAt, lastActionText, lastActionAuthor };
      });

      return res.status(200).json({ cases: casesWithLastAction, total, page, limit });
    } catch (err) {
      logError("GET /service/cases error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

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
      initialNote,
    } = req.body;

    if (!typeId || !statusId || !priorityId || !summary?.trim()) {
      return res.status(400).json({
        error: "typeId, statusId, priorityId, and summary are required",
      });
    }

    try {
      const now = new Date();
      const yy = String(now.getFullYear()).slice(2);
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const datePrefix = `CS-${yy}${mm}${dd}`;

      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 86400000);

      const todayCount = await prisma.serviceCase.count({
        where: {
          created: { gte: startOfDay, lt: endOfDay },
        },
      });

      const caseNumber = `${datePrefix}-${String(todayCount + 1).padStart(3, "0")}`;

      const result = await prisma.$transaction(async (tx) => {
        const serviceCase = await tx.serviceCase.create({
          data: {
            caseNumber,
            typeId,
            statusId,
            priorityId,
            summary: summary.trim(),
            customerId: customerId || null,
            salesOrderId: salesOrderId || null,
            vendorId: vendorId || null,
            salesPersonId: salesPersonId || null,
            assignedToId: assignedToId || null,
            storeLocation: storeLocation || null,
            preferredContact: preferredContact || null,
            itemDescription: itemDescription || null,
            partNo: partNo || null,
            createdBy: session.user?.email || null,
          },
        });

        if (initialNote?.trim()) {
          const staff = await tx.staffMember.findFirst({
            where: { email: session.user?.email },
          });

          await tx.serviceCaseNote.create({
            data: {
              caseId: serviceCase.id,
              authorId: staff?.id || null,
              note: initialNote.trim(),
              isInternal: true,
              createdBy: session.user?.email || null,
            },
          });
        }

        return tx.serviceCase.findUnique({
          where: { id: serviceCase.id },
          include: {
            type: { select: { id: true, name: true } },
            status: { select: { id: true, name: true, isClosed: true, color: true } },
            priority: { select: { id: true, name: true, color: true } },
            customer: { select: { id: true, firstName: true, lastName: true } },
            assignedTo: { select: { id: true, displayName: true } },
            notes: true,
          },
        });
      });

      return res.status(201).json(result);
    } catch (err) {
      logError("POST /service/cases error", err);
      return res.status(500).json({ error: "Failed to create service case" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
