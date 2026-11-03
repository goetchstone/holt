// /app/src/pages/api/order-disclaimers/index.ts
//
// GAP-07: the store's disclaimers (lib/sales/orderDisclaimers.ts). GET is the
// active list for the order page, so anyone who reads sales can read it; GET
// ?all=1 (with how many orders each is on) and POST are Settings >
// Disclaimers, admin.settings. Per-method gates follow referral-sources/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { DisclaimerError, createDisclaimer, listDisclaimers } from "@/lib/sales/orderDisclaimers";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    if (req.query.all) return requirePermission("admin.settings", handleAll)(req, res);
    return requirePermission({ anyOf: ["sales.read", "admin.settings"] }, handleActive)(req, res);
  }
  if (req.method === "POST") return requirePermission("admin.settings", handlePost)(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export async function handleActive(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const disclaimers = await listDisclaimers(prisma, { activeOnly: true });
    return res.status(200).json(disclaimers.map(({ id, name, text }) => ({ id, name, text })));
  } catch (err) {
    logError("GET /api/order-disclaimers error", err);
    return res.status(500).json({ error: "Failed to load disclaimers" });
  }
}

export async function handleAll(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const disclaimers = await listDisclaimers(prisma);
    return res
      .status(200)
      .json(disclaimers.map(({ _count, ...d }) => ({ ...d, orderCount: _count.orders })));
  } catch (err) {
    logError("GET /api/order-disclaimers?all error", err);
    return res.status(500).json({ error: "Failed to load disclaimers" });
  }
}

export async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const disclaimer = await prisma.$transaction((tx) =>
      createDisclaimer(tx, req.body ?? {}, session.user?.email ?? null),
    );
    return res.status(201).json(disclaimer);
  } catch (err) {
    if (err instanceof DisclaimerError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/order-disclaimers error", err);
    return res.status(500).json({ error: "Failed to add the disclaimer" });
  }
}
