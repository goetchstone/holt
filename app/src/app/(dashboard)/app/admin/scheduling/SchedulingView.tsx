// /app/src/app/(dashboard)/app/admin/scheduling/SchedulingView.tsx
//
// Manage the Service catalog, weekly availability windows, and time-off blocks.
// All three drive the public /book slot picker. Talks to /api/services +
// /api/scheduling/{windows,blocks}. Client component.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { DAY_OF_WEEK_LABELS } from "@/lib/booking/scheduling";

interface ServiceRow {
  id: number;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number | null;
  isPublic: boolean;
  isActive: boolean;
}

interface WindowRow {
  id: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  service: { id: number; name: string } | null;
}

interface BlockRow {
  id: number;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? fallback;
  } catch {
    return fallback;
  }
}

export function SchedulingView() {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [windows, setWindows] = useState<WindowRow[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, wRes, bRes] = await Promise.all([
        fetch("/api/services"),
        fetch("/api/scheduling/windows"),
        fetch("/api/scheduling/blocks"),
      ]);
      if (sRes.ok) setServices(((await sRes.json()) as { services: ServiceRow[] }).services);
      if (wRes.ok) setWindows(((await wRes.json()) as { windows: WindowRow[] }).windows);
      if (bRes.ok) setBlocks(((await bRes.json()) as { blocks: BlockRow[] }).blocks);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load scheduling"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-sh-gray">Loading…</p>;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-sh-blue">Scheduling</h1>
        <p className="mt-1 text-sm text-sh-gray">
          Services, weekly hours, and time off power the public{" "}
          <Link href="/book" className="text-sh-blue hover:underline">
            booking page
          </Link>
          . With no services + windows, booking falls back to the flat hours in Settings.
        </p>
      </header>

      <ServicesSection services={services} onChange={load} />
      <WindowsSection windows={windows} services={services} onChange={load} />
      <BlocksSection blocks={blocks} onChange={load} />
    </div>
  );
}

function ServicesSection({
  services,
  onChange,
}: Readonly<{ services: ServiceRow[]; onChange: () => void }>) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("30");
  const [price, setPrice] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          durationMinutes: Number(duration),
          price: price ? Number(price) : null,
          isPublic,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not add service"));
      setName("");
      setDuration("30");
      setPrice("");
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not add service"));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(s: ServiceRow, field: "isPublic" | "isActive") {
    try {
      const res = await fetch(`/api/services/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: !s[field] }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not update"));
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not update"));
    }
  }

  async function remove(s: ServiceRow) {
    if (!window.confirm(`Delete "${s.name}"?`)) return;
    try {
      const res = await fetch(`/api/services/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not delete"));
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not delete"));
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-sh-black">Services</h2>
      <form
        onSubmit={add}
        className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-black/10 bg-sh-linen p-4"
      >
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="min-h-[44px] w-56 rounded-md border border-black/15 bg-white px-3 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Minutes</span>
          <input
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            required
            className="min-h-[44px] w-24 rounded-md border border-black/15 bg-white px-3 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Price</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="—"
            className="min-h-[44px] w-28 rounded-md border border-black/15 bg-white px-3 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-sh-gray">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="h-4 w-4"
          />
          Public
        </label>
        <button
          type="submit"
          disabled={saving}
          className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
        >
          {saving ? "…" : "Add"}
        </button>
      </form>

      {services.length === 0 ? (
        <p className="mt-3 text-sm text-sh-gray">No services yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-black/5 rounded-md border border-black/10">
          {services.map((s) => (
            <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span>
                <span className="font-medium text-sh-black">{s.name}</span>
                <span className="ml-2 text-sh-gray">
                  {s.durationMinutes} min{s.price != null ? ` · $${s.price}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => toggle(s, "isPublic")}
                  className="text-xs text-sh-blue hover:underline"
                >
                  {s.isPublic ? "Public" : "Hidden"}
                </button>
                <button
                  type="button"
                  onClick={() => toggle(s, "isActive")}
                  className="text-xs text-sh-blue hover:underline"
                >
                  {s.isActive ? "Active" : "Inactive"}
                </button>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WindowsSection({
  windows,
  services,
  onChange,
}: Readonly<{ windows: WindowRow[]; services: ServiceRow[]; onChange: () => void }>) {
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [serviceId, setServiceId] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/scheduling/windows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dayOfWeek: Number(dayOfWeek),
          startTime,
          endTime,
          serviceId: serviceId ? Number(serviceId) : null,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not add window"));
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not add window"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    try {
      const res = await fetch(`/api/scheduling/windows/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not delete"));
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not delete"));
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-sh-black">Weekly hours</h2>
      <form
        onSubmit={add}
        className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-black/10 bg-sh-linen p-4"
      >
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Day</span>
          <select
            value={dayOfWeek}
            onChange={(e) => setDayOfWeek(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          >
            {DAY_OF_WEEK_LABELS.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">From</span>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">To</span>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Service</span>
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          >
            <option value="">All services</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={saving}
          className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
        >
          {saving ? "…" : "Add"}
        </button>
      </form>

      {windows.length === 0 ? (
        <p className="mt-3 text-sm text-sh-gray">
          No windows — booking uses the flat hours from Settings.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-black/5 rounded-md border border-black/10">
          {windows.map((w) => (
            <li key={w.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-sh-black">
                <span className="font-medium">{DAY_OF_WEEK_LABELS[w.dayOfWeek]}</span> {w.startTime}
                –{w.endTime}
                <span className="ml-2 text-sh-gray">
                  {w.service ? w.service.name : "All services"}
                </span>
              </span>
              <button
                type="button"
                onClick={() => remove(w.id)}
                className="text-xs text-red-700 hover:underline"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BlocksSection({
  blocks,
  onChange,
}: Readonly<{ blocks: BlockRow[]; onChange: () => void }>) {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!startsAt || !endsAt) {
      toast.error("Pick a start and end");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/scheduling/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          reason: reason || null,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not add time off"));
      setStartsAt("");
      setEndsAt("");
      setReason("");
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not add time off"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    try {
      const res = await fetch(`/api/scheduling/blocks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Could not delete"));
      onChange();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not delete"));
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-sh-black">Time off / closures</h2>
      <form
        onSubmit={add}
        className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-black/10 bg-sh-linen p-4"
      >
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">From</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">To</span>
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="min-h-[44px] rounded-md border border-black/15 bg-white px-2 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-sh-black">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Holiday"
            className="min-h-[44px] w-48 rounded-md border border-black/15 bg-white px-3 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={saving}
          className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
        >
          {saving ? "…" : "Add"}
        </button>
      </form>

      {blocks.length === 0 ? (
        <p className="mt-3 text-sm text-sh-gray">No time off scheduled.</p>
      ) : (
        <ul className="mt-3 divide-y divide-black/5 rounded-md border border-black/10">
          {blocks.map((b) => (
            <li key={b.id} className="flex items-center justify-between px-4 py-2 text-sm">
              <span className="text-sh-black">
                {dateTimeFmt.format(new Date(b.startsAt))} –{" "}
                {dateTimeFmt.format(new Date(b.endsAt))}
                {b.reason ? <span className="ml-2 text-sh-gray">{b.reason}</span> : null}
              </span>
              <button
                type="button"
                onClick={() => remove(b.id)}
                className="text-xs text-red-700 hover:underline"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
