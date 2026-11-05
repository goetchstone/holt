// /app/src/pages/api/customers/[id]/client-profile.ts
//
// GET: a client's Client Info, their notes and contacts, and this store's choices.
// What a salesperson keeps on a client (budget, how likely they are to close) is for the
// people who deal with clients: customer.write or sales.lead. Warehouse, Dispatch and
// Installers can read a customer to deliver to them, and don't get this.
//
// PUT: save it, which is pipeline work (sales.lead, like the pipeline).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getAppSettings, getBusinessTimeZone } from "@/lib/appSettings";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  EMPTY_CLIENT_PROFILE,
  parseClientProfileBody,
  toClientProfileView,
} from "@/lib/clientProfile";
import { isCashSaleCustomer } from "@/lib/pipelineClient";
import { businessDayKey } from "@/lib/reports/businessDay";

const HISTORY_LIMIT = 100;

function readCustomerId(req: NextApiRequest): number | null {
  const id = Number.parseInt(req.query.id as string, 10);
  return Number.isNaN(id) ? null : id;
}

const handleGet = requirePermission(
  { anyOf: ["customer.write", "sales.lead"] },
  async (req, res) => {
    const customerId = readCustomerId(req);
    if (customerId === null) return res.status(400).json({ error: "Invalid customer ID" });
    try {
      const [row, settings, timeZone, history] = await Promise.all([
        prisma.clientProfile.findUnique({ where: { customerId } }),
        getAppSettings(),
        getBusinessTimeZone(),
        prisma.customerInteraction.findMany({
          where: { customerId },
          orderBy: { startedAt: "desc" },
          take: HISTORY_LIMIT,
          select: {
            id: true,
            source: true,
            notes: true,
            startedAt: true,
            createdBy: true,
            staffMember: { select: { displayName: true } },
            salesOrder: { select: { id: true, orderno: true } },
          },
        }),
      ]);
      return res.status(200).json({
        profile: row ? toClientProfileView(row) : EMPTY_CLIENT_PROFILE,
        choices: settings.clientProfileChoices,
        today: businessDayKey(new Date(), timeZone),
        history,
      });
    } catch (err) {
      logError("Failed to load client profile", err);
      return res.status(500).json({ error: "Failed to load client info" });
    }
  },
);

const handlePut = requirePermission("sales.lead", async (req, res, session: Session) => {
  const customerId = readCustomerId(req);
  if (customerId === null) return res.status(400).json({ error: "Invalid customer ID" });

  try {
    const [current, settings] = await Promise.all([
      prisma.clientProfile.findUnique({ where: { customerId } }),
      getAppSettings(),
    ]);
    const parsed = parseClientProfileBody(req.body, settings.clientProfileChoices, current);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { firstName: true, lastName: true },
    });
    if (!customer) return res.status(404).json({ error: "Client not found" });
    if (isCashSaleCustomer(customer)) {
      return res
        .status(400)
        .json({ error: "Client info can't be saved on the Cash Sale customer." });
    }

    const userEmail = session.user?.email ?? null;
    const row = await prisma.clientProfile.upsert({
      where: { customerId },
      create: { customerId, ...parsed.data, createdBy: userEmail, updatedBy: userEmail },
      update: { ...parsed.data, updatedBy: userEmail },
    });
    return res.status(200).json({ profile: toClientProfileView(row) });
  } catch (err) {
    logError("Failed to save client profile", err);
    return res.status(500).json({ error: "Failed to save client info" });
  }
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "PUT") return handlePut(req, res);
  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).json({ error: "Method not allowed" });
}
