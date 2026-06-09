// /app/src/components/cms/CommentForm.tsx
//
// Public blog comment form. Posts to /api/comments (rate-limited, moderated).
// Inline success/error -- the public (site) layout has no toast container.

"use client";

import { useState } from "react";
import { getErrorMessage } from "@/lib/toastError";

export function CommentForm({ postId }: { postId: number }) {
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, authorName, authorEmail, content }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "Failed");
      setDone(true);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Could not post your comment"));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p className="rounded-md bg-sh-stripe p-4 text-sm text-sh-gray">
        Thanks — your comment has been submitted and is awaiting moderation.
      </p>
    );
  }

  const field = "w-full rounded-md border border-black/15 px-3 py-2 text-sm";

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="c-name" className="mb-1 block text-sm text-sh-gray">
            Name
          </label>
          <input
            id="c-name"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            required
            className={field}
          />
        </div>
        <div>
          <label htmlFor="c-email" className="mb-1 block text-sm text-sh-gray">
            Email (not published)
          </label>
          <input
            id="c-email"
            type="email"
            value={authorEmail}
            onChange={(e) => setAuthorEmail(e.target.value)}
            required
            className={field}
          />
        </div>
      </div>
      <div>
        <label htmlFor="c-content" className="mb-1 block text-sm text-sh-gray">
          Comment
        </label>
        <textarea
          id="c-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
          rows={4}
          className={field}
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button
        type="submit"
        disabled={submitting}
        className="min-h-[44px] rounded-md bg-sh-navy px-5 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
      >
        {submitting ? "Posting…" : "Post comment"}
      </button>
    </form>
  );
}
