// /app/src/pages/api/comments/index.ts
//
// POST (public) -- submit a blog comment. Rate-limited, gated by the
// `blogComments` feature, captures IP + user-agent for spam triage. The comment
// lands PENDING and only renders publicly once a moderator approves it.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { rateLimit } from "@/lib/rateLimit";
import { parseCommentCreateInput } from "@/lib/comments/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 5 });

function clientIp(req: NextApiRequest): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? null;
}

const createComment = limiter(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    const settings = await getAppSettings();
    if (!isFeatureEnabled(settings.features, "blogComments")) {
      return res.status(404).json({ error: "Comments are not enabled" });
    }
    const input = parseCommentCreateInput(req.body);
    const post = await prisma.post.findFirst({
      where: { id: input.postId, organizationId: DEFAULT_ORG_ID, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!post) return res.status(404).json({ error: "Post not found" });

    await prisma.blogComment.create({
      data: {
        organizationId: DEFAULT_ORG_ID,
        postId: post.id,
        authorName: input.authorName,
        authorEmail: input.authorEmail,
        content: input.content,
        ipAddress: clientIp(req),
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
      },
    });
    return res.status(201).json({ ok: true });
  } catch (err: unknown) {
    logError("Comment create failed", err);
    return res.status(400).json({ error: getErrorMessage(err, "Could not post your comment") });
  }
});

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  return createComment(req, res);
}
