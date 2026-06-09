// /app/src/pages/api/proposals/index.ts
//
// GET: List proposals with pagination, status filter, search.
// POST: Create a new draft proposal with generated BP-YYMMDD-NNN number.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") return handleGet(req, res);
    if (req.method === "POST") return handlePost(req, res, session.user?.email ?? null);
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).end();
  },
);

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    const page = Math.max(1, Number.parseInt((req.query.page as string) || "1", 10));
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt((req.query.limit as string) || "20", 10)),
    );
    const status = req.query.status as string | undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;

    const where: Prisma.ProposalWhereInput = {};
    if (status) where.status = status as Prisma.EnumProposalStatusFilter;
    if (search) {
      where.OR = [
        { proposalNumber: { contains: search, mode: "insensitive" } },
        { projectName: { contains: search, mode: "insensitive" } },
        { companyName: { contains: search, mode: "insensitive" } },
        { customer: { firstName: { contains: search, mode: "insensitive" } } },
        { customer: { lastName: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [proposals, total] = await Promise.all([
      prisma.proposal.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { created: "desc" },
        include: {
          customer: { select: { firstName: true, lastName: true } },
          salesPerson: { select: { displayName: true } },
          _count: { select: { lineItems: true } },
        },
      }),
      prisma.proposal.count({ where }),
    ]);

    return res.status(200).json({ proposals, total, page, limit });
  } catch (err: unknown) {
    logError("Failed to list proposals", err);
    return res.status(500).json({ error: "Failed to list proposals" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  try {
    const { customerId, projectName, companyName, salesPersonId } = req.body;

    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const prefix = `BP-${yy}${mm}${dd}-`;

    const last = await prisma.proposal.findFirst({
      where: { proposalNumber: { startsWith: prefix } },
      orderBy: { proposalNumber: "desc" },
      select: { proposalNumber: true },
    });

    let seq = 1;
    if (last) {
      const lastSeq = Number.parseInt(last.proposalNumber.replace(prefix, ""), 10);
      if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
    }

    const proposalNumber = `${prefix}${String(seq).padStart(3, "0")}`;

    const proposal = await prisma.proposal.create({
      data: {
        proposalNumber,
        customerId: customerId ? Number(customerId) : undefined,
        projectName: projectName || null,
        companyName: companyName || null,
        salesPersonId: salesPersonId ? Number(salesPersonId) : undefined,
        createdBy,
      },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        salesPerson: { select: { displayName: true } },
      },
    });

    logger.info("Created B2B proposal", { proposalNumber, createdBy });

    return res.status(201).json(proposal);
  } catch (err: unknown) {
    logError("Failed to create proposal", err);
    return res.status(500).json({ error: "Failed to create proposal" });
  }
}
