// /app/src/app/(dashboard)/app/admin/cms/menus/MenusEditorView.tsx
//
// Edits the public site header and footer navigation. Each menu is a flat list
// of { label, href } items (the schema also supports one level of children,
// editable in a later iteration). Client over /api/cms/menus/[location].

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import type { MenuItem, MenuLocation } from "@/lib/cms/menu";

function MenuSection({ location, title }: { location: MenuLocation; title: string }) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cms/menus/${location}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load menu");
      const data = await res.json();
      setItems(data.items);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load menu"));
    } finally {
      setLoading(false);
    }
  }, [location]);

  useEffect(() => {
    void load();
  }, [load]);

  function update(i: number, patch: Partial<MenuItem>) {
    setItems(items.map((item, j) => (j === i ? { ...item, ...patch } : item)));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/cms/menus/${location}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      toast.success(`${title} saved`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-black/10 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold text-sh-navy">{title}</h2>
      {loading ? (
        <p className="text-sh-gray">Loading…</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={item.label}
                  placeholder="Label"
                  onChange={(e) => update(i, { label: e.target.value })}
                  className="w-1/3 rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
                />
                <input
                  type="text"
                  value={item.href}
                  placeholder="/about or https://..."
                  onChange={(e) => update(i, { href: e.target.value })}
                  className="flex-1 rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="Remove item"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                  className="text-sh-gray hover:text-red-600"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setItems([...items, { label: "", href: "", children: [] }])}
              className="inline-flex items-center gap-1 rounded-md border border-sh-navy/30 px-3 py-1.5 text-sm text-sh-navy hover:bg-sh-linen"
            >
              <Plus size={14} /> Add item
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-sh-navy px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function MenusEditorView() {
  return (
    <div className="mx-auto flex max-w-screen-lg flex-col gap-6 px-4 py-6">
      <h1 className="text-2xl font-semibold text-sh-blue">Menus</h1>
      <MenuSection location="header" title="Header navigation" />
      <MenuSection location="footer" title="Footer navigation" />
    </div>
  );
}
