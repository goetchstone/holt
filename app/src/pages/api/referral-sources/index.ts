// /app/src/pages/api/referral-sources/index.ts
//
// GAP-08: the store's referral sources -- how customers heard of it
// (lib/customers/referrals.ts). GET is the active list for the customer form,
// so anyone who reads customers can read it; GET ?all=1 (with each source's
// customer count) and POST are Settings > Referral sources, admin.settings.
// Per-method gates follow tenders/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import {
  ReferralError,
  createReferralSource,
  listReferralSources,
} from "@/lib/customers/referrals";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    if (req.query.all) return requirePermission("admin.settings", handleAll)(req, res);
    return requirePermission({ anyOf: ["customer.read", "admin.settings"] }, handleActive)(
      req,
      res,
    );
  }
  if (req.method === "POST") return requirePermission("admin.settings", handlePost)(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export async function handleActive(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const sources = await listReferralSources(prisma, { activeOnly: true });
    return res.status(200).json(sources.map(({ id, name }) => ({ id, name })));
  } catch (err) {
    logError("GET /api/referral-sources error", err);
    return res.status(500).json({ error: "Failed to load referral sources" });
  }
}

export async function handleAll(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const sources = await listReferralSources(prisma);
    return res
      .status(200)
      .json(sources.map(({ _count, ...s }) => ({ ...s, customerCount: _count.customers })));
  } catch (err) {
    logError("GET /api/referral-sources?all error", err);
    return res.status(500).json({ error: "Failed to load referral sources" });
  }
}

export async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const source = await prisma.$transaction((tx) =>
      createReferralSource(tx, req.body ?? {}, session.user?.email ?? null),
    );
    return res.status(201).json(source);
  } catch (err) {
    if (err instanceof ReferralError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/referral-sources error", err);
    return res.status(500).json({ error: "Failed to add the referral source" });
  }
}
