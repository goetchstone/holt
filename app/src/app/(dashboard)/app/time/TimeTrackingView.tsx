// /app/src/app/(dashboard)/app/time/TimeTrackingView.tsx
//
// Log + review time entries. The duration field accepts shorthand ("1h30m",
// "1.5h", "90") parsed client-side to minutes before posting. Privileged users
// (canSeeAll) get a Mine/Team toggle and a staff column. Customer linkage is an
// optional typeahead over /api/customers.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { parseDurationToMinutes, formatMinutes } from "@/lib/timeEntries/duration";
import { summarizeTimeEntries } from "@/lib/timeEntries/summary";

interface EntryRow {
  id: number;
  description: string;
  minutes: number;
  date: string;
  isBillable: boolean;
  billedAt: string | null;
  staffMember: { id: number; displayName: string };
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
}

interface CustomerMatch {
  id: number;
  firstName: string | null;
  lastName: string | null;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function customerName(c: { firstName: string | null; lastName: string | null }): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Customer";
}

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TimeTrackingView({ canSeeAll }: Readonly<{ canSeeAll: boolean }>) {
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"mine" | "all">("mine");

  const [description, setDescription] = useState("");
  const [duration, setDuration] = useState("");
  const [date, setDate] = useState(todayInputValue());
  const [isBillable, setIsBillable] = useState(true);
  const [saving, setSaving] = useState(false);

  const [customer, setCustomer] = useState<CustomerMatch | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerMatches, setCustomerMatches] = useState<CustomerMatch[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (canSeeAll && scope === "all") params.set("all", "true");
      const res = await fetch(`/api/time-entries?${params.toString()}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data = (await res.json()) as { entries: EntryRow[] };
      setEntries(data.entries);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load time entries"));
    } finally {
      setLoading(false);
    }
  }, [canSeeAll, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeTimeEntries(entries), [entries]);

  async function searchCustomers(term: string) {
    setCustomerSearch(term);
    if (term.trim().length < 2) {
      setCustomerMatches([]);
      return;
    }
    try {
      const res = await fetch(`/api/customers?search=${encodeURIComponent(term)}&limit=6`);
      if (!res.ok) return;
      const data = (await res.json()) as { data: CustomerMatch[] };
      setCustomerMatches(data.data);
    } catch {
      setCustomerMatches([]);
    }
  }

  function pickCustomer(c: CustomerMatch) {
    setCustomer(c);
    setCustomerSearch("");
    setCustomerMatches([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let minutes: number;
    try {
      minutes = parseDurationToMinutes(duration);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Enter a valid duration"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/time-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          minutes,
          date,
          isBillable,
          customerId: customer?.id ?? null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      setDescription("");
      setDuration("");
      setCustomer(null);
      await load();
      toast.success("Time logged");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not save time entry"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleBilled(entry: EntryRow) {
    try {
      const res = await fetch(`/api/time-entries/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billed: !entry.billedAt }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update");
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not update"));
    }
  }

  async function remove(entry: EntryRow) {
    if (!window.confirm("Delete this time entry?")) return;
    try {
      const res = await fetch(`/api/time-entries/${entry.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not delete");
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not delete"));
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-sh-blue">Time Tracking</h1>

      <section className="mt-5 grid gap-3 rounded-md border border-black/10 bg-sh-linen p-4">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-12 sm:items-end">
          <label className="block text-sm sm:col-span-5">
            <span className="mb-1 block font-medium text-sh-black">What did you work on?</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-3 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block font-medium text-sh-black">Time</span>
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              required
              placeholder="1h30m"
              className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-3 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block font-medium text-sh-black">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-sh-gray sm:col-span-2">
            <input
              type="checkbox"
              checked={isBillable}
              onChange={(e) => setIsBillable(e.target.checked)}
              className="h-4 w-4"
            />
            Billable
          </label>
          <button
            type="submit"
            disabled={saving}
            className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60 sm:col-span-1"
          >
            {saving ? "…" : "Log"}
          </button>
        </form>

        <div className="relative max-w-sm text-sm">
          {customer ? (
            <div className="flex items-center gap-2">
              <span className="text-sh-gray">Customer:</span>
              <span className="rounded bg-white px-2 py-1 text-sh-black">
                {customerName(customer)}
              </span>
              <button
                type="button"
                onClick={() => setCustomer(null)}
                className="text-xs text-sh-blue hover:underline"
              >
                clear
              </button>
            </div>
          ) : (
            <>
              <input
                value={customerSearch}
                onChange={(e) => void searchCustomers(e.target.value)}
                placeholder="Link a customer (optional)…"
                className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-3 text-sm"
              />
              {customerMatches.length > 0 ? (
                <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-black/15 bg-white shadow">
                  {customerMatches.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pickCustomer(c)}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-sh-stripe"
                      >
                        {customerName(c)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      </section>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-sh-gray">
          <span className="font-medium text-sh-black">{formatMinutes(summary.totalMinutes)}</span>{" "}
          total · <span className="text-sh-black">{formatMinutes(summary.billableMinutes)}</span>{" "}
          billable ·{" "}
          <span className="text-sh-black">{formatMinutes(summary.unbilledBillableMinutes)}</span>{" "}
          unbilled
        </p>
        {canSeeAll ? (
          <div className="inline-flex overflow-hidden rounded-md border border-black/10">
            {(["mine", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`min-h-[44px] px-4 text-sm font-medium transition ${
                  scope === s ? "bg-sh-navy text-white" : "bg-white text-sh-gray hover:bg-sh-stripe"
                }`}
              >
                {s === "mine" ? "Mine" : "Team"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-3">
        {renderTable(entries, loading, scope === "all" && canSeeAll, toggleBilled, remove)}
      </div>
    </div>
  );
}

function renderTable(
  entries: EntryRow[],
  loading: boolean,
  showStaff: boolean,
  toggleBilled: (e: EntryRow) => void,
  remove: (e: EntryRow) => void,
) {
  if (loading) return <p className="text-sh-gray">Loading…</p>;
  if (entries.length === 0) return <p className="text-sh-gray">No time logged yet.</p>;
  return (
    <div className="overflow-hidden rounded-md border border-black/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-sh-stripe text-sh-gray">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Description</th>
            {showStaff ? <th className="px-3 py-2 font-medium">Who</th> : null}
            <th className="px-3 py-2 font-medium">Customer</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Billable</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-black/5">
              <td className="px-3 py-2 text-sh-gray">{dateFmt.format(new Date(e.date))}</td>
              <td className="px-3 py-2 text-sh-black">{e.description}</td>
              {showStaff ? (
                <td className="px-3 py-2 text-sh-gray">{e.staffMember.displayName}</td>
              ) : null}
              <td className="px-3 py-2 text-sh-gray">
                {e.customer ? customerName(e.customer) : "—"}
              </td>
              <td className="px-3 py-2 text-sh-black">{formatMinutes(e.minutes)}</td>
              <td className="px-3 py-2">
                {e.isBillable ? (
                  <button
                    type="button"
                    onClick={() => toggleBilled(e)}
                    className={`rounded px-2 py-0.5 text-xs ${
                      e.billedAt
                        ? "bg-green-100 text-green-800"
                        : "bg-sh-gold/20 text-sh-gold hover:bg-sh-gold/30"
                    }`}
                  >
                    {e.billedAt ? "Billed" : "Unbilled"}
                  </button>
                ) : (
                  <span className="text-xs text-sh-gray">Non-billable</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => remove(e)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
