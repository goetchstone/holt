// /app/src/app/(dashboard)/app/admin/cms/comments/CommentsModerationView.tsx
//
// Moderate blog comments: filter by status, then approve / reject / spam each.
// Over /api/admin/comments (GET) + /api/admin/comments/[id] (PATCH).

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  COMMENT_STATUS_VALUES,
  COMMENT_STATUS_LABELS,
  COMMENT_MODERATION_VALUES,
  type CommentStatusValue,
  type CommentModerationValue,
} from "@/lib/comments/contract";

interface Comment {
  id: number;
  authorName: string;
  authorEmail: string;
  content: string;
  status: CommentStatusValue;
  ipAddress: string | null;
  created: string;
  post: { title: string; slug: string } | null;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const ACTION_STYLES: Record<CommentModerationValue, string> = {
  APPROVED: "bg-green-600 hover:bg-green-700",
  REJECTED: "bg-sh-gray hover:bg-sh-black",
  SPAM: "bg-red-600 hover:bg-red-700",
};

export function CommentsModerationView() {
  const [status, setStatus] = useState<CommentStatusValue>("PENDING");
  const [comments, setComments] = useState<Comment[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (s: CommentStatusValue) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/comments?status=${s}`);
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      const data = (await res.json()) as { comments: Comment[]; counts: Record<string, number> };
      setComments(data.comments);
      setCounts(data.counts);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load comments"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  async function moderate(id: number, next: CommentModerationValue) {
    try {
      const res = await fetch(`/api/admin/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      toast.success(`Marked ${COMMENT_STATUS_LABELS[next].toLowerCase()}`);
      await load(status);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not update comment"));
    }
  }

  return (
    <div>
      <PageHeader
        title="Blog comments"
        subtitle="Approve, reject, or mark blog comments as spam."
      />

      <div className="flex flex-wrap gap-2">
        {COMMENT_STATUS_VALUES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`min-h-[40px] rounded-md px-3 text-sm ${
              status === s ? "bg-sh-navy text-white" : "bg-sh-stripe text-sh-gray"
            }`}
          >
            {COMMENT_STATUS_LABELS[s]}
            {counts[s] ? ` (${counts[s]})` : ""}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-4">
        {loading ? (
          <p className="text-sh-gray">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="text-sh-gray">No {COMMENT_STATUS_LABELS[status].toLowerCase()} comments.</p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="rounded-md border border-black/10 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-sh-navy">
                  {c.authorName}{" "}
                  <span className="font-normal text-sh-gray">&lt;{c.authorEmail}&gt;</span>
                </p>
                <p className="text-xs text-sh-gray">{dateFmt.format(new Date(c.created))}</p>
              </div>
              {c.post ? (
                <p className="mt-1 text-xs text-sh-gray">
                  on <span className="text-sh-black">{c.post.title}</span>
                </p>
              ) : null}
              <p className="mt-2 whitespace-pre-wrap text-sh-black">{c.content}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {COMMENT_MODERATION_VALUES.filter((m) => m !== c.status).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => moderate(c.id, m)}
                    className={`min-h-[36px] rounded px-3 text-xs font-medium text-white ${ACTION_STYLES[m]}`}
                  >
                    {COMMENT_STATUS_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
