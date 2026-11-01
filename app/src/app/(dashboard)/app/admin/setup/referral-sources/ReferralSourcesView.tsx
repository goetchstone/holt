"use client";

// /app/src/app/(dashboard)/app/admin/setup/referral-sources/ReferralSourcesView.tsx
//
// Settings -> Referral sources: the store's own list of how customers hear of
// it (lib/customers/referrals.ts). Add, rename, switch off; a source no
// customer has can be deleted. Reads and writes /api/referral-sources.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface SourceRow {
  id: number;
  name: string;
  isActive: boolean;
  sortOrder: number;
  customerCount: number;
}

export function ReferralSourcesView() {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<SourceRow[]>("/api/referral-sources", { params: { all: 1 } })
        .then((res) => setSources(res.data))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load sources")))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (request: Promise<unknown>, done: string) => {
    try {
      await request;
      toast.success(done);
      await load();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the source."));
      return false;
    }
  };

  const add = async () => {
    const ok = await send(
      axios.post("/api/referral-sources", { name: newName, sortOrder: sources.length }),
      "Source added.",
    );
    if (ok) setNewName("");
  };

  return (
    <div className="py-2 font-serif">
      <div className="mb-6 max-w-2xl text-brand-gray">
        <p>
          How your customers hear of you: a friend, Instagram, a designer, a sign on the road. Staff
          pick one on each customer, and Reports › Referrals counts customers and sales by source
          and by who sent them.
        </p>
        <p className="mt-2 text-sm">
          A source customers already have is switched off rather than deleted, so their records keep
          it.
        </p>
      </div>

      <div className="mb-6 flex max-w-md items-end gap-2">
        <div className="flex-1">
          <label htmlFor="new-source" className="mb-1 block text-sm text-brand-gray">
            New source
          </label>
          <input
            id="new-source"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-brand-accent-gray px-3 py-2"
          />
        </div>
        <Button onClick={add} disabled={!newName.trim()}>
          Add
        </Button>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && sources.length === 0 && (
        <p className="text-brand-gray">No referral sources yet.</p>
      )}
      {!loading && sources.length > 0 && (
        <table className="w-full max-w-3xl border-collapse">
          <thead>
            <tr className="border-b border-brand-gray/30 text-left">
              <th className="py-3 px-4 font-semibold text-brand-blue">Name</th>
              <th className="py-3 px-4 font-semibold text-brand-blue text-right">Customers</th>
              <th className="py-3 px-4 font-semibold text-brand-blue text-center">Status</th>
              <th className="py-3 px-4" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <SourceRowView key={s.id} source={s} send={send} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SourceRowView({
  source,
  send,
}: Readonly<{
  source: SourceRow;
  send: (request: Promise<unknown>, done: string) => Promise<boolean>;
}>) {
  const [name, setName] = useState(source.name);
  const url = `/api/referral-sources/${source.id}`;
  return (
    <tr className="border-b border-brand-gray/10 odd:bg-white even:bg-brand-stripe">
      <td className="py-2 px-4">
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={`Name of ${source.name}`}
            className="w-56 rounded border border-brand-gray/30 px-2 py-1"
          />
          {name.trim() !== source.name && (
            <button
              type="button"
              onClick={() => send(axios.put(url, { name }), "Renamed.")}
              className="text-sm text-brand-blue underline"
            >
              Save
            </button>
          )}
        </div>
      </td>
      <td className="py-2 px-4 text-right">{source.customerCount}</td>
      <td className="py-2 px-4 text-center">
        <button
          type="button"
          onClick={() =>
            send(
              axios.put(url, { isActive: !source.isActive }),
              source.isActive ? "Switched off." : "Switched on.",
            )
          }
          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
            source.isActive ? "bg-green-100 text-green-800" : "bg-brand-gray/20 text-brand-gray"
          }`}
        >
          {source.isActive ? "On" : "Off"}
        </button>
      </td>
      <td className="py-2 px-4 text-right">
        {source.customerCount === 0 && (
          <button
            type="button"
            onClick={() => send(axios.delete(url), "Deleted.")}
            className="text-sm text-red-600 underline"
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}
