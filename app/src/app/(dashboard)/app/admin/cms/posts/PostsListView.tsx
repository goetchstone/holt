// /app/src/app/(dashboard)/app/admin/cms/posts/PostsListView.tsx
//
// Lists CMS blog posts with create/edit/delete. Client over /api/cms/posts.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface PostRow {
  id: number;
  slug: string;
  title: string;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: string | null;
  updated: string | null;
}

export function PostsListView() {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cms/posts");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load posts");
      const data = await res.json();
      setPosts(data.posts);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load posts"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: number, title: string) {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/cms/posts/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204)
        throw new Error((await res.json()).error ?? "Delete failed");
      toast.success("Post deleted");
      void load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Delete failed"));
    }
  }

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-sh-blue">Posts</h1>
        <Link
          href="/app/admin/cms/posts/new"
          className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue"
        >
          New post
        </Link>
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="text-sh-gray">No posts yet. Write your first one.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-black/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-sh-stripe text-sh-gray">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Slug</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id} className="border-t border-black/5">
                  <td className="px-4 py-2">
                    <Link
                      href={`/app/admin/cms/posts/${post.id}`}
                      className="font-medium text-sh-navy hover:underline"
                    >
                      {post.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-sh-gray">/blog/{post.slug}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        post.status === "PUBLISHED"
                          ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
                          : "rounded bg-black/5 px-2 py-0.5 text-xs text-sh-gray"
                      }
                    >
                      {post.status === "PUBLISHED" ? "Published" : "Draft"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(post.id, post.title)}
                      className="text-sm text-sh-gray hover:text-red-600"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
