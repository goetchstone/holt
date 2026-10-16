"use client";

// /app/src/app/(dashboard)/app/inventory/counts/CountsView.tsx
//
// Submitted counts and what posting each would change now; posting needs
// Adjust inventory, and the server says so when it is missing (rule 11).

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface CountRow {
  id: number;
  status: string;
  scope: string;
  place: string;
  store: string;
  countedAt: string;
  countedBy: string | null;
  postedAt: string | null;
  lines: {
    productId: number;
    productName: string;
    productNumber: string;
    counted: number;
    expected: number;
    difference: number;
  }[];
}

export function CountsView() {
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get<{ counts: CountRow[] }>("/api/inventory/counts");
      setCounts(res.data.counts);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not load counts."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: number, action: "post" | "cancel") => {
    setBusy(id);
    try {
      await axios.post(`/api/inventory/counts/${id}`, { action });
      toast.success(action === "post" ? "Count posted." : "Count cancelled.");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "The count was not changed."));
    } finally {
      setBusy(null);
    }
  };

  const waiting = counts.filter((c) => c.status === "SUBMITTED");
  const posted = counts.filter((c) => c.status === "POSTED");

  const table = (c: CountRow) => (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-brand-gray border-b border-brand-gray/20">
          <th className="py-1 pr-3">Product</th>
          <th className="py-1 pr-3 text-right">Counted</th>
          <th className="py-1 pr-3 text-right">Books</th>
          <th className="py-1 text-right">Difference</th>
        </tr>
      </thead>
      <tbody>
        {c.lines.map((l) => (
          <tr key={l.productId} className="border-b border-brand-gray/10">
            <td className="py-1 pr-3">
              {l.productName} <span className="text-xs text-brand-gray">{l.productNumber}</span>
            </td>
            <td className="py-1 pr-3 text-right">{l.counted}</td>
            <td className="py-1 pr-3 text-right">{l.expected}</td>
            <td
              className={`py-1 text-right ${l.difference < 0 ? "text-red-700" : l.difference > 0 ? "text-green-800" : ""}`}
            >
              {l.difference > 0 ? `+${l.difference}` : l.difference}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Counts</h1>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Waiting to be posted</h2>
        {waiting.length === 0 && <p className="text-sm text-brand-gray">None.</p>}
        {waiting.map((c) => (
          <div key={c.id} className="bg-white p-4 rounded-lg shadow-sm space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">
                  {c.place} · {c.store}
                </span>{" "}
                <span className="text-brand-gray">
                  {c.scope === "PRODUCTS" ? "quick count" : "everything here"}, by{" "}
                  {c.countedBy ?? "?"} {c.countedAt.slice(0, 16).replace("T", " ")}
                </span>
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => act(c.id, "post")} disabled={busy === c.id}>
                  Post
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => act(c.id, "cancel")}
                  disabled={busy === c.id}
                >
                  Cancel
                </Button>
              </div>
            </div>
            {table(c)}
          </div>
        ))}
      </section>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Posted</h2>
        {posted.length === 0 && <p className="text-sm text-brand-gray">None yet.</p>}
        {posted.map((c) => (
          <details key={c.id} className="bg-white p-4 rounded-lg shadow-sm">
            <summary className="text-sm cursor-pointer">
              {c.place} · {c.store} · posted {c.postedAt?.slice(0, 10)} ·{" "}
              {c.lines.filter((l) => l.difference !== 0).length} changed
            </summary>
            {table(c)}
          </details>
        ))}
      </section>
    </div>
  );
}
