// /app/src/pages/api/customers/email-list.ts
//
// GAP-08: a filtered customer email list (lib/customers/emailList.ts).
//   GET ?boughtFrom=&boughtTo=&storeLocationId=&minLevel=&trade=&referralSourceId=
//       -> { count, sample }: how many match, and the first few to check by eye
//   GET ...&format=csv -> the list as a CSV download
// A list of customers' emails leaves the building, so it needs "Run marketing"
// (list sync), not just "View customers".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import {
  EmailListError,
  emailList,
  emailListCsv,
  readEmailListFilter,
} from "@/lib/customers/emailList";

const SAMPLE = 10;

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const filter = readEmailListFilter(req.query);
    const rows = await emailList(prisma, filter, (await getAppSettings()).timezone);
    if (req.query.format === "csv") {
      await auditLog("DATA_EXPORTED", auditActor(session), {
        summary: `Customer email list exported: ${rows.length} addresses`,
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="customer-emails.csv"');
      return res.status(200).send(emailListCsv(rows));
    }
    return res.status(200).json({ count: rows.length, sample: rows.slice(0, SAMPLE) });
  } catch (err) {
    if (err instanceof EmailListError) return res.status(400).json({ error: err.message });
    logError("Customer email list failed", err);
    return res.status(500).json({ error: "Failed to build the email list" });
  }
}

export default requirePermission("marketing.write", handler);
