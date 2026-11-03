// /app/src/pages/api/order-flags/index.ts
//
// GAP-07: the store's order flags (lib/sales/orderFlags.ts). GET is the active
// list for the order page and the orders list, so anyone who reads sales can
// read it; GET ?all=1 (with each flag's order count) and POST are Settings >
// Order flags, admin.settings. Per-method gates follow referral-sources/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { OrderFlagError, createOrderFlag, listOrderFlags } from "@/lib/sales/orderFlags";

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
    const flags = await listOrderFlags(prisma, { activeOnly: true });
    return res
      .status(200)
      .json(flags.map(({ id, name, color, alertOnOpen }) => ({ id, name, color, alertOnOpen })));
  } catch (err) {
    logError("GET /api/order-flags error", err);
    return res.status(500).json({ error: "Failed to load order flags" });
  }
}

export async function handleAll(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const flags = await listOrderFlags(prisma);
    return res
      .status(200)
      .json(flags.map(({ _count, ...f }) => ({ ...f, orderCount: _count.orders })));
  } catch (err) {
    logError("GET /api/order-flags?all error", err);
    return res.status(500).json({ error: "Failed to load order flags" });
  }
}

export async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const flag = await prisma.$transaction((tx) =>
      createOrderFlag(tx, req.body ?? {}, session.user?.email ?? null),
    );
    return res.status(201).json(flag);
  } catch (err) {
    if (err instanceof OrderFlagError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/order-flags error", err);
    return res.status(500).json({ error: "Failed to add the flag" });
  }
}
