// /app/src/pages/api/mailchimp/backfill-customer-links.ts
//
// Backfill MailchimpActivity.customerId for orphan rows. When the activity
// sync runs before a Customer record exists for that email (e.g. the
// activity landed in 2023 but the customer got imported later), the
// activity row is left with customerId = NULL and never re-linked.
// This endpoint does a one-shot UPDATE joining MailchimpActivity to
// Customer by email.
//
// Safe to run repeatedly. Returns the number of rows updated and a count
// of remaining unlinked rows (i.e. activities whose email doesn't match
// any Customer).
//
// MANAGER/ADMIN or Bearer AUTO_IMPORT_API_KEY.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { activeStaffRole } from "@/lib/auth/requireAuth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";

async function isAuthorized(req: NextApiRequest, session: unknown): Promise<boolean> {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  // Database, not the token. The Bearer path above is for cron; this branch is a
  // human, and a demoted or deactivated one kept access until their JWT expired.
  const role = await activeStaffRole(session as { user?: { id?: string | null } | null } | null);
  if (role === "ADMIN" || role === "SUPER_ADMIN" || role === "MANAGER") return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const session = await getServerSession(req, res, authOptions);
  if (!(await isAuthorized(req, session))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Update orphan activities in one pass: join MailchimpActivity to
    // Customer by email (case-insensitive), set customerId. Postgres
    // UPDATE ... FROM syntax.
    const before = await prisma.mailchimpActivity.count({ where: { customerId: null } });
    const result = await prisma.$executeRawUnsafe<number>(`
      UPDATE "MailchimpActivity" ma
      SET "customerId" = c.id
      FROM "Customer" c
      WHERE ma."customerId" IS NULL
        AND LOWER(ma.email) = LOWER(c.email)
    `);
    const after = await prisma.mailchimpActivity.count({ where: { customerId: null } });

    logger.info("Mailchimp activity customer-link backfill complete", {
      rowsUpdated: result,
      orphansBefore: before,
      orphansAfter: after,
    });

    return res.status(200).json({
      rowsUpdated: Number(result),
      orphansBefore: before,
      orphansAfter: after,
      note:
        after > 0
          ? `${after} activity rows still have no matching Customer by email. Those are Mailchimp subscribers we don't have as customers.`
          : "All activity rows are now linked to a Customer.",
    });
  } catch (err: unknown) {
    logError("Mailchimp customer-link backfill failed", err);
    return res.status(500).json({ error: "Backfill failed" });
  }
}
