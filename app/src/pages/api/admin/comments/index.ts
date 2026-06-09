// /app/src/pages/api/admin/comments/index.ts
//
// GET (ADMIN) -- list blog comments for moderation. Defaults to PENDING; pass
// ?status=APPROVED|REJECTED|SPAM|PENDING to filter. Returns per-status counts
// for the moderation tabs.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { COMMENT_STATUS_VALUES, type CommentStatusValue } from "@/lib/comments/contract";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const statusParam = req.query.status as string | undefined;
    const status: CommentStatusValue =
      statusParam && COMMENT_STATUS_VALUES.includes(statusParam as CommentStatusValue)
        ? (statusParam as CommentStatusValue)
        : "PENDING";

    const where: Prisma.BlogCommentWhereInput = { organizationId: DEFAULT_ORG_ID, status };
    const [comments, grouped] = await Promise.all([
      prisma.blogComment.findMany({
        where,
        orderBy: { created: "desc" },
        take: 200,
        select: {
          id: true,
          authorName: true,
          authorEmail: true,
          content: true,
          status: true,
          ipAddress: true,
          created: true,
          post: { select: { title: true, slug: true } },
        },
      }),
      prisma.blogComment.groupBy({
        by: ["status"],
        where: { organizationId: DEFAULT_ORG_ID },
        _count: true,
      }),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));
    return res.status(200).json({ comments, counts, status });
  },
);
