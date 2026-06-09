// /app/src/app/(dashboard)/app/admin/cms/pages/PageEditorView.tsx
//
// Create/edit a CMS page: title, slug, status, home flag, SEO, and the block
// editor. pageId === null is create mode (POST); otherwise edit (PUT).

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

export function PageEditorView({ pageId }: { pageId: number | null }) {
  const router = useRouter();
  const isNew = pageId === null;

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [status, setStatus] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [isHome, setIsHome] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [blocks, setBlocks] = useState<ContentBlock[]>([]);

  const load = useCallback(async () => {
    if (pageId === null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/cms/pages/${pageId}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load page");
      const { page } = await res.json();
      setTitle(page.title);
      setSlug(page.slug);
      setSlugTouched(true);
      setStatus(page.status);
      setIsHome(page.isHome);
      setSeoTitle(page.seoTitle ?? "");
      setSeoDescription(page.seoDescription ?? "");
      setBlocks(parseBlocks(page.blocks));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load page"));
    } finally {
      setLoading(false);
    }
  }, [pageId]);

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
      const res = await fetch(isNew ? "/api/cms/pages" : `/api/cms/pages/${pageId}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, slug, status, isHome, seoTitle, seoDescription, blocks }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      toast.success("Page saved");
      router.push("/app/admin/cms/pages");
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
        <h1 className="text-2xl font-semibold text-sh-blue">{isNew ? "New page" : "Edit page"}</h1>
        <Link href="/app/admin/cms/pages" className="text-sm text-sh-gray hover:text-sh-navy">
          Back to pages
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

          <label className="flex items-center gap-2 text-sm text-sh-gray">
            <input type="checkbox" checked={isHome} onChange={(e) => setIsHome(e.target.checked)} />
            Set as home page (served at /)
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">SEO title</span>
            <input
              type="text"
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-sh-gray">SEO description</span>
            <textarea
              value={seoDescription}
              rows={3}
              onChange={(e) => setSeoDescription(e.target.value)}
              className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
            />
          </label>

          <button
            type="button"
            onClick={save}
            disabled={saving || !title || !slug}
            className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save page"}
          </button>
        </aside>
      </div>
    </div>
  );
}
