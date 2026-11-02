"use client";

// /app/src/app/(dashboard)/app/sales/customers/email-list/EmailListView.tsx
//
// Pick who is on the list -- bought between two days, at a store, at a level,
// trade or retail, by how they heard of you -- see how many match and a few of
// them, then download the CSV (GET /api/customers/email-list).

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { getErrorMessage } from "@/lib/toastError";

interface Option {
  id: number;
  name: string;
}

interface Preview {
  count: number;
  sample: { email: string; firstName: string | null; lastName: string | null }[];
}

export function EmailListView() {
  const [stores, setStores] = useState<Option[]>([]);
  const [sources, setSources] = useState<Option[]>([]);
  const [filter, setFilter] = useState({
    boughtFrom: "",
    boughtTo: "",
    storeLocationId: "",
    minLevel: "",
    trade: "",
    referralSourceId: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    axios
      .get<{ locations: Option[] }>("/api/store-locations", { params: { isActive: "true" } })
      .then((res) => setStores(res.data.locations))
      .catch(() => setStores([]));
    axios
      .get<Option[]>("/api/referral-sources")
      .then((res) => setSources(res.data))
      .catch(() => setSources([]));
  }, []);

  const query = useMemo(
    () =>
      new URLSearchParams(
        Object.entries(filter).filter(([, v]) => v !== "") as [string, string][],
      ).toString(),
    [filter],
  );

  useEffect(() => {
    let live = true;
    axios
      .get<Preview>(`/api/customers/email-list?${query}`)
      .then((res) => {
        if (!live) return;
        setPreview(res.data);
        setError(null);
      })
      .catch((err) => {
        if (!live) return;
        setPreview(null);
        setError(getErrorMessage(err, "Couldn't build the list."));
      });
    return () => {
      live = false;
    };
  }, [query]);

  const set = (key: keyof typeof filter) => (value: string) =>
    setFilter((f) => ({ ...f, [key]: value }));
  const field = "rounded border border-brand-gray/30 px-2 py-1 text-sm";

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Customer email list</h1>
      <p className="max-w-2xl text-sm text-brand-gray">
        Everyone with an email who matches, as a CSV for your mailing tool. Holt keeps no record of
        who has unsubscribed, so send through a tool that honours unsubscribes (Mailchimp does).
      </p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Bought from
          <input
            type="date"
            value={filter.boughtFrom}
            onChange={(e) => set("boughtFrom")(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1">
          Bought to
          <input
            type="date"
            value={filter.boughtTo}
            onChange={(e) => set("boughtTo")(e.target.value)}
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1">
          At store
          <select
            value={filter.storeLocationId}
            onChange={(e) => set("storeLocationId")(e.target.value)}
            className={field}
          >
            <option value="">Any store</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Level at least
          <input
            type="number"
            min={0}
            value={filter.minLevel}
            onChange={(e) => set("minLevel")(e.target.value)}
            className={`${field} w-20`}
          />
        </label>
        <label className="flex flex-col gap-1">
          Trade
          <select
            value={filter.trade}
            onChange={(e) => set("trade")(e.target.value)}
            className={field}
          >
            <option value="">Trade and retail</option>
            <option value="trade">Trade only</option>
            <option value="retail">Retail only</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Heard of us through
          <select
            value={filter.referralSourceId}
            onChange={(e) => set("referralSourceId")(e.target.value)}
            className={field}
          >
            <option value="">Any source</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {preview && (
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <p className="text-sm">
              <strong>{preview.count}</strong> {preview.count === 1 ? "customer" : "customers"}
            </p>
            <button
              type="button"
              disabled={preview.count === 0}
              onClick={() => window.open(`/api/customers/email-list?${query}&format=csv`, "_blank")}
              className="rounded border border-brand-blue px-3 py-1 text-sm text-brand-blue disabled:opacity-40"
            >
              Download CSV
            </button>
          </div>
          {preview.sample.length > 0 && (
            <ul className="text-xs text-brand-gray">
              {preview.sample.map((r) => (
                <li key={r.email}>
                  {[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"} · {r.email}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
