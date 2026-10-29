// /app/src/pages/api/tenders/index.ts
//
// The payment types a store sets up for itself (lib/payments/tenders.ts).
// GET ?for=register is the register's tender buttons, so anyone who takes
// payments reads it; the full list (with each tender's GL account and whether
// payments use it) and POST are Settings -> Payment Types, admin.settings.
// Per-method gates follow warehouse/locations/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { createTender, listTenders, tenderAccounts, TenderError } from "@/lib/payments/tenders";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    if (req.query.for === "register") {
      return requirePermission({ anyOf: ["payment.take", "admin.settings"] }, handleOffered)(
        req,
        res,
      );
    }
    return requirePermission("admin.settings", handleList)(req, res);
  }
  if (req.method === "POST") {
    return requirePermission("admin.settings", handlePost)(req, res);
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleOffered(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const tenders = await listTenders(prisma, "register");
    return res.status(200).json(
      tenders.map(({ id, name, kind, referenceRequired }) => ({
        id,
        name,
        kind,
        referenceRequired,
      })),
    );
  } catch (err) {
    logError("GET /api/tenders?for=register error", err);
    return res.status(500).json({ error: "Failed to load payment types" });
  }
}

async function handleList(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const tenders = await listTenders(prisma);
    const accounts = await tenderAccounts(
      prisma,
      tenders.map((t) => t.name),
    );
    return res.status(200).json(
      tenders.map(({ _count, ...t }) => ({
        ...t,
        paymentCount: _count.payments,
        glAccount: accounts.get(t.name) ?? null,
      })),
    );
  } catch (err) {
    logError("GET /api/tenders error", err);
    return res.status(500).json({ error: "Failed to load payment types" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const tender = await prisma.$transaction((tx) =>
      createTender(tx, req.body ?? {}, session.user?.email ?? null),
    );
    return res.status(201).json(tender);
  } catch (err) {
    if (err instanceof TenderError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/tenders error", err);
    return res.status(500).json({ error: "Failed to add the payment type" });
  }
}
