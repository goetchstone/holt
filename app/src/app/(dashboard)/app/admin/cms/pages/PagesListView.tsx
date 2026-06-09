// /app/src/app/(dashboard)/app/admin/cms/pages/PagesListView.tsx
//
// Lists CMS pages with create/edit/delete. Client component over /api/cms/pages.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface PageRow {
  id: number;
  slug: string;
  title: string;
  status: "DRAFT" | "PUBLISHED";
  isHome: boolean;
  updated: string | null;
}

export function PagesListView() {
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cms/pages");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load pages");
      const data = await res.json();
      setPages(data.pages);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load pages"));
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
      const res = await fetch(`/api/cms/pages/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        throw new Error((await res.json()).error ?? "Delete failed");
      }
      toast.success("Page deleted");
      void load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Delete failed"));
    }
  }

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-sh-blue">Pages</h1>
        <Link
          href="/app/admin/cms/pages/new"
          className="rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue"
        >
          New page
        </Link>
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading…</p>
      ) : pages.length === 0 ? (
        <p className="text-sh-gray">No pages yet. Create your first one.</p>
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
              {pages.map((page) => (
                <tr key={page.id} className="border-t border-black/5">
                  <td className="px-4 py-2">
                    <Link
                      href={`/app/admin/cms/pages/${page.id}`}
                      className="font-medium text-sh-navy hover:underline"
                    >
                      {page.title}
                    </Link>
                    {page.isHome ? (
                      <span className="ml-2 rounded bg-sh-gold/20 px-1.5 py-0.5 text-xs text-sh-gold">
                        Home
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-sh-gray">/{page.slug}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        page.status === "PUBLISHED"
                          ? "rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
                          : "rounded bg-black/5 px-2 py-0.5 text-xs text-sh-gray"
                      }
                    >
                      {page.status === "PUBLISHED" ? "Published" : "Draft"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(page.id, page.title)}
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
