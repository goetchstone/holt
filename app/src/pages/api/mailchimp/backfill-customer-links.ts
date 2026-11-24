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
// Gated by guardAutomation, like every other automation trigger: the
// scheduler's Bearer AUTO_IMPORT_API_KEY, or a session holding "Run scheduled
// jobs" (admin.automations). Its only screen, Admin > Automations > Mailchimp
// Sync, opens on Change settings, which the same roles hold by default.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";

async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
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

export default guardAutomation(run);
