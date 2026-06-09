// /app/src/pages/api/cms/posts/[id].ts
//
// Single CMS blog post. GET / PUT / DELETE. ADMIN-gated. Sets publishedAt on
// first publish.

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
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    if (req.method === "GET") {
      const post = await prisma.post.findFirst({
        where: { id, organizationId: DEFAULT_ORG_ID },
      });
      if (!post) return res.status(404).json({ error: "Post not found" });
      return res.json({ post });
    }

    if (req.method === "PUT") {
      try {
        const input = parsePostInput(req.body);
        const existing = await prisma.post.findFirst({
          where: { id, organizationId: DEFAULT_ORG_ID },
          select: { publishedAt: true },
        });
        if (!existing) return res.status(404).json({ error: "Post not found" });

        const publishedAt =
          input.status === "PUBLISHED" ? (existing.publishedAt ?? new Date()) : null;

        const post = await prisma.post.update({
          where: { id },
          data: {
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
            publishedAt,
            updatedBy: session.user?.email ?? null,
          },
        });
        return res.json({ post });
      } catch (err: unknown) {
        if (getErrorCode(err) === "P2002") {
          return res.status(409).json({ error: "A post with that slug already exists" });
        }
        logError("CMS post update failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not save post") });
      }
    }

    if (req.method === "DELETE") {
      try {
        await prisma.post.delete({ where: { id } });
        return res.status(204).end();
      } catch (err: unknown) {
        logError("CMS post delete failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not delete post") });
      }
    }

    res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
);
