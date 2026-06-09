// /app/src/pages/api/cms/pages/[id].ts
//
// Single CMS page. GET reads it, PUT updates (content/status/home), DELETE
// removes it. ADMIN-gated. Sets publishedAt on first publish; keeps a single
// home page per org.

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
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid page id" });
    }

    if (req.method === "GET") {
      const page = await prisma.page.findFirst({
        where: { id, organizationId: DEFAULT_ORG_ID },
      });
      if (!page) return res.status(404).json({ error: "Page not found" });
      return res.json({ page });
    }

    if (req.method === "PUT") {
      try {
        const input = parsePageInput(req.body);
        const existing = await prisma.page.findFirst({
          where: { id, organizationId: DEFAULT_ORG_ID },
          select: { publishedAt: true },
        });
        if (!existing) return res.status(404).json({ error: "Page not found" });

        const publishedAt =
          input.status === "PUBLISHED" ? (existing.publishedAt ?? new Date()) : null;

        const page = await prisma.$transaction(async (tx) => {
          if (input.isHome) {
            await tx.page.updateMany({
              where: { organizationId: DEFAULT_ORG_ID, isHome: true, id: { not: id } },
              data: { isHome: false },
            });
          }
          return tx.page.update({
            where: { id },
            data: {
              slug: input.slug,
              title: input.title,
              status: input.status,
              isHome: input.isHome,
              blocks: input.blocks,
              seoTitle: input.seoTitle ?? null,
              seoDescription: input.seoDescription ?? null,
              publishedAt,
              updatedBy: session.user?.email ?? null,
            },
          });
        });
        return res.json({ page });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A page with that slug already exists" });
        }
        logError("CMS page update failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not save page") });
      }
    }

    if (req.method === "DELETE") {
      try {
        await prisma.page.delete({ where: { id } });
        return res.status(204).end();
      } catch (err: unknown) {
        logError("CMS page delete failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not delete page") });
      }
    }

    res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
