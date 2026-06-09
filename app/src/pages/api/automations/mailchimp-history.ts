// /app/src/pages/api/automations/mailchimp-history.ts
//
// Paginated run log for the Mailchimp automation. Powers the admin page's
// history table.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).end();

  const page = Math.max(1, Number.parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt((req.query.limit as string) || "20", 10)),
  );
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;

  const where = kind ? { kind } : {};

  const [rows, total] = await Promise.all([
    prisma.mailchimpSyncLog.findMany({
      where,
      orderBy: { created: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.mailchimpSyncLog.count({ where }),
  ]);

  return res.status(200).json({
    rows,
    total,
    page,
    limit,
  });
}
