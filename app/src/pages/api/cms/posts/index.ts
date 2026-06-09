// /app/src/pages/api/cms/posts/index.ts
//
// CMS blog posts collection. GET lists; POST creates. ADMIN-gated.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parsePostInput } from "@/lib/cms/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { getErrorCode } from "@/lib/errorCode";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method === "GET") {
      const posts = await prisma.post.findMany({
        where: { organizationId: DEFAULT_ORG_ID },
        orderBy: [{ updated: "desc" }],
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          publishedAt: true,
          updated: true,
        },
      });
      return res.json({ posts });
    }

    if (req.method === "POST") {
      try {
        const input = parsePostInput(req.body);
        const email = session.user?.email ?? null;
        const post = await prisma.post.create({
          data: {
            organizationId: DEFAULT_ORG_ID,
            slug: input.slug,
            title: input.title,
            status: input.status,
            excerpt: input.excerpt ?? null,
            coverImageUrl: input.coverImageUrl ?? null,
            author: input.author ?? null,
            category: input.category ?? null,
            tags: input.tags,
            blocks: input.blocks,
            seoTitle: input.seoTitle ?? null,
            seoDescription: input.seoDescription ?? null,
            publishedAt: input.status === "PUBLISHED" ? new Date() : null,
            createdBy: email,
            updatedBy: email,
          },
        });
        return res.status(201).json({ post });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A post with that slug already exists" });
        }
        logError("CMS post create failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not create post") });
      }
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
