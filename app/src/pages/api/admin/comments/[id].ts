// /app/src/pages/api/admin/comments/[id].ts
//
// PATCH (ADMIN) -- moderate a comment: APPROVED (renders publicly), REJECTED, or
// SPAM. Approving stamps approvedAt + approvedBy.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseCommentModerationInput } from "@/lib/comments/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "PATCH") {
      res.setHeader("Allow", ["PATCH"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid comment id" });

    try {
      const input = parseCommentModerationInput(req.body);
      const existing = await prisma.blogComment.findFirst({
        where: { id, organizationId: DEFAULT_ORG_ID },
        select: { id: true },
      });
      if (!existing) return res.status(404).json({ error: "Comment not found" });

      const approved = input.status === "APPROVED";
      const comment = await prisma.blogComment.update({
        where: { id },
        data: {
          status: input.status,
          approvedAt: approved ? new Date() : null,
          approvedBy: approved ? (session.user?.email ?? null) : null,
        },
        select: { id: true, status: true },
      });
      return res.status(200).json({ comment });
    } catch (err: unknown) {
      logError("Comment moderation failed", err);
      return res.status(400).json({ error: getErrorMessage(err, "Could not update comment") });
    }
  },
);
