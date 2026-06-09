// /app/src/app/(dashboard)/app/admin/cms/posts/PostEditorView.tsx
//
// Create/edit a CMS blog post: title, slug, status, excerpt, author, category,
// cover image, and the block editor. postId === null is create mode.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { BlockEditor } from "@/components/cms/admin/BlockEditor";
import { parseBlocks, type ContentBlock } from "@/lib/cms/blocks";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function PostEditorView({ postId }: { postId: number | null }) {
  const router = useRouter();
  const isNew = postId === null;

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [excerpt, setExcerpt] = useState("");
  const [author, setAuthor] = useState("");
  const [category, setCategory] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);

  const load = useCallback(async () => {
    if (postId === null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/cms/posts/${postId}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load post");
      const { post } = await res.json();
      setTitle(post.title);
      setSlug(post.slug);
      setSlugTouched(true);
      setStatus(post.status);
      setExcerpt(post.excerpt ?? "");
      setAuthor(post.author ?? "");
      setCategory(post.category ?? "");
      setCoverImageUrl(post.coverImageUrl ?? "");
      setBlocks(parseBlocks(post.blocks));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load post"));
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    void load();
  }, [load]);

  function onTitleChange(value: string) {
    setTitle(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(isNew ? "/api/cms/posts" : `/api/cms/posts/${postId}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          slug,
          status,
          excerpt,
          author,
          category,
          coverImageUrl,
          tags: [],
          blocks,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      toast.success("Post saved");
      router.push("/app/admin/cms/posts");
      router.refresh();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="mx-auto max-w-screen-lg px-4 py-6 text-sh-gray">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-sh-blue">{isNew ? "New post" : "Edit post"}</h1>
        <Link href="/app/admin/cms/posts" className="text-sm text-sh-gray hover:text-sh-navy">
          Back to posts
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,280px]">
        <div className="flex flex-col gap-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 focus:border-sh-navy focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Excerpt</span>
            <textarea
              value={excerpt}
              rows={2}
              onChange={(e) => setExcerpt(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-sh-navy">Content</h2>
            <BlockEditor blocks={blocks} onChange={setBlocks} />
          </div>
        </div>

        <aside className="flex flex-col gap-4 rounded-md border border-black/10 bg-white p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as "DRAFT" | "PUBLISHED")}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            >
              <option value="DRAFT">Draft</option>
              <option value="PUBLISHED">Published</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Slug</span>
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Author</span>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Category</span>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">Cover image URL</span>
            <input
              type="text"
              value={coverImageUrl}
              onChange={(e) => setCoverImageUrl(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={save}
            disabled={saving || !title || !slug}
            className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save post"}
          </button>
        </aside>
      </div>
    </div>
  );
}
