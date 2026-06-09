// /app/src/pages/api/cms/pages/index.ts
//
// CMS pages collection. GET lists pages for the org; POST creates one.
// ADMIN-gated. Enforces a single home page per organization.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parsePageInput } from "@/lib/cms/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const pages = await prisma.page.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: [{ isHome: "desc" }, { updated: "desc" }],
        select: { id: true, slug: true, title: true, status: true, isHome: true, updated: true },
      });
      return res.json({ pages });
    }

    if (req.method === "POST") {
      try {
        const input = parsePageInput(req.body);
        const email = session.user?.email ?? null;
        const page = await prisma.$transaction(async (tx) => {
          if (input.isHome) {
            await tx.page.updateMany({
              where: { organizationId: DEFAULT_ORG_ID, isHome: true },
              data: { isHome: false },
            });
          }
          return tx.page.create({
            data: {
              organizationId: DEFAULT_ORG_ID,
              slug: input.slug,
              title: input.title,
              status: input.status,
              isHome: input.isHome,
              blocks: input.blocks,
              seoTitle: input.seoTitle ?? null,
              seoDescription: input.seoDescription ?? null,
              publishedAt: input.status === "PUBLISHED" ? new Date() : null,
              createdBy: email,
              updatedBy: email,
            },
          });
        });
        return res.status(201).json({ page });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A page with that slug already exists" });
        }
        logError("CMS page create failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not create page") });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
