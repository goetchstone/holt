// /app/src/pages/api/proposals/[id]/index.ts
//
// GET: Full proposal with line items and images.
// PUT: Update proposal header (status, text, customer).
// DELETE: Delete a draft proposal.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const id = Number.parseInt(req.query.id as string, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid proposal ID" });

    if (req.method === "GET") return handleGet(id, res);
    if (req.method === "PUT") return handlePut(id, req, res, session.user?.email ?? null);
    if (req.method === "DELETE") return handleDelete(id, res);
    res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
    return res.status(405).end();
  },
);

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            tradeCompanyName: true,
            addresses: { take: 1 },
          },
        },
        salesPerson: { select: { id: true, displayName: true } },
        lineItems: {
          orderBy: { sortOrder: "asc" },
          include: {
            images: { orderBy: { sortOrder: "asc" } },
            product: { select: { imageUrl: true } },
          },
        },
      },
    });

    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    return res.status(200).json(proposal);
  } catch (err: unknown) {
    logError("Failed to fetch proposal", err);
    return res.status(500).json({ error: "Failed to fetch proposal" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  try {
    const {
      customerId,
      projectName,
      companyName,
      coverLetter,
      terms,
      internalNotes,
      salesPersonId,
      status,
      expiresAt,
    } = req.body;

    const data: Record<string, unknown> = { updatedBy };
    if (customerId !== undefined) data.customerId = customerId ? Number(customerId) : null;
    if (projectName !== undefined) data.projectName = projectName;
    if (companyName !== undefined) data.companyName = companyName;
    if (coverLetter !== undefined) data.coverLetter = coverLetter;
    if (terms !== undefined) data.terms = terms;
    if (internalNotes !== undefined) data.internalNotes = internalNotes;
    if (salesPersonId !== undefined)
      data.salesPersonId = salesPersonId ? Number(salesPersonId) : null;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;

    if (status === "SENT") {
      data.status = "SENT";
      data.sentAt = new Date();
    } else if (status === "DECLINED") {
      data.status = "DECLINED";
    } else if (status === "EXPIRED") {
      data.status = "EXPIRED";
    }

    const proposal = await prisma.proposal.update({
      where: { id },
      data,
      include: {
        customer: { select: { firstName: true, lastName: true } },
        salesPerson: { select: { displayName: true } },
      },
    });

    logger.info("Updated proposal", { id, status: proposal.status, updatedBy });
    return res.status(200).json(proposal);
  } catch (err: unknown) {
    logError("Failed to update proposal", err);
    return res.status(500).json({ error: "Failed to update proposal" });
  }
}

async function handleDelete(id: number, res: NextApiResponse) {
  try {
    const proposal = await prisma.proposal.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.status !== "DRAFT") {
      return res.status(400).json({ error: "Only draft proposals can be deleted" });
    }

    await prisma.proposal.delete({ where: { id } });
    logger.info("Deleted proposal", { id });
    return res.status(200).json({ deleted: true });
  } catch (err: unknown) {
    logError("Failed to delete proposal", err);
    return res.status(500).json({ error: "Failed to delete proposal" });
  }
}
