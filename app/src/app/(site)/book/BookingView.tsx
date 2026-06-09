// /app/src/app/(site)/book/BookingView.tsx
//
// Public booking flow (client). When a Service catalog is configured the visitor
// picks a service first, then a slot for that service; otherwise it falls back
// to a single flat-hours slot list (zero-config deployments). Stages: (service)
// -> slot -> details -> confirmation with an "Add to calendar" .ics link. Talks
// to the public /api/bookings + /api/services/public endpoints. Surfaces server
// error messages via getErrorMessage (CLAUDE.md rule 11). Themed sh-* tokens.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface Slot {
  startsAt: string;
  endsAt: string;
}

interface PublicService {
  id: number;
  name: string;
  description: string | null;
  durationMinutes: number;
  price: number | null;
}

interface CreatedBooking {
  id: number;
  startsAt: string;
  endsAt: string;
  customerName: string;
  icsToken: string;
}

interface DayGroup {
  key: string;
  label: string;
  slots: Slot[];
}

const dayLabelFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function groupByDay(slots: Slot[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const slot of slots) {
    const date = new Date(slot.startsAt);
    const key = dayKey(date);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: dayLabelFmt.format(date), slots: [] };
      groups.set(key, group);
    }
    group.slots.push(slot);
  }
  return [...groups.values()];
}

function serviceMeta(s: PublicService): string {
  const duration = `${s.durationMinutes} min`;
  return s.price != null ? `${duration} · $${s.price}` : duration;
}

export function BookingView() {
  const [services, setServices] = useState<PublicService[]>([]);
  const [servicesLoaded, setServicesLoaded] = useState(false);
  const [selectedService, setSelectedService] = useState<PublicService | null>(null);

  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<CreatedBooking | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const loadAvailability = useCallback(async (serviceId?: number) => {
    setLoadingSlots(true);
    try {
      const qs = serviceId ? `?serviceId=${serviceId}` : "";
      const res = await fetch(`/api/bookings/availability${qs}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load availability");
      const data = (await res.json()) as { slots: Slot[] };
      setSlots(data.slots);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load availability"));
    } finally {
      setLoadingSlots(false);
    }
  }, []);

  // Load the public service catalog once. No services -> go straight to the flat
  // slot list (legacy behavior).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/services/public");
        const data = res.ok
          ? ((await res.json()) as { services: PublicService[] })
          : { services: [] };
        if (!active) return;
        setServices(data.services);
        setServicesLoaded(true);
        if (data.services.length === 0) void loadAvailability();
      } catch {
        if (!active) return;
        setServices([]);
        setServicesLoaded(true);
        void loadAvailability();
      }
    })();
    return () => {
      active = false;
    };
  }, [loadAvailability]);

  function pickService(service: PublicService) {
    setSelectedService(service);
    setSelected(null);
    void loadAvailability(service.id);
  }

  const days = useMemo(() => groupByDay(slots), [slots]);
  const hasServices = services.length > 0;
  const showSlots = !hasServices || selectedService != null;

  function renderSlots() {
    if (hasServices && !selectedService) {
      return <p className="mt-4 text-sh-gray">Choose a service to see available times.</p>;
    }
    if (loadingSlots) return <p className="mt-4 text-sh-gray">Loading available times…</p>;
    if (days.length === 0) {
      return (
        <p className="mt-4 text-sh-gray">
          No times are available right now. Please check back soon.
        </p>
      );
    }
    return (
      <div className="mt-4 space-y-6">
        {days.map((day) => (
          <div key={day.key}>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-sh-gray">
              {day.label}
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {day.slots.map((slot) => (
                <SlotButton
                  key={slot.startsAt}
                  slot={slot}
                  selected={selected?.startsAt === slot.startsAt}
                  onSelect={setSelected}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) {
      toast.error("Please choose a time slot");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: name,
          customerEmail: email,
          customerPhone: phone || undefined,
          notes: notes || undefined,
          serviceId: selectedService?.id,
          startsAt: selected.startsAt,
          endsAt: selected.endsAt,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not book that time");
      const data = (await res.json()) as { booking: CreatedBooking };
      setConfirmed(data.booking);
      toast.success("Your consultation is booked");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not book that time"));
      void loadAvailability(selectedService?.id);
      setSelected(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    const start = new Date(confirmed.startsAt);
    return (
      <section className="mt-10 rounded-lg border border-sh-gray/20 bg-sh-linen p-8">
        <h2 className="font-serif text-2xl text-sh-navy">You&apos;re booked</h2>
        <p className="mt-3 text-sh-gray">
          Thanks, {confirmed.customerName}. We&apos;ve reserved{" "}
          <span className="font-medium text-sh-black">
            {dayLabelFmt.format(start)} at {timeFmt.format(start)}
          </span>
          . A confirmation will follow by email.
        </p>
        <a
          href={`/api/bookings/${confirmed.id}/ics?token=${encodeURIComponent(confirmed.icsToken)}`}
          className="mt-6 inline-block rounded-md bg-sh-navy px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sh-blue"
        >
          Add to calendar
        </a>
      </section>
    );
  }

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[1.2fr_1fr]">
      <section>
        {hasServices ? (
          <>
            <h2 className="font-serif text-2xl text-sh-navy">Choose a service</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pickService(s)}
                  aria-pressed={selectedService?.id === s.id}
                  className={`rounded-lg border p-4 text-left transition ${
                    selectedService?.id === s.id
                      ? "border-sh-navy bg-sh-navy/5"
                      : "border-sh-gray/30 bg-white hover:border-sh-navy"
                  }`}
                >
                  <span className="block font-medium text-sh-black">{s.name}</span>
                  <span className="mt-1 block text-xs uppercase tracking-wide text-sh-gray">
                    {serviceMeta(s)}
                  </span>
                  {s.description ? (
                    <span className="mt-2 block text-sm text-sh-gray">{s.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <h2 className={`font-serif text-2xl text-sh-navy ${hasServices ? "mt-8" : ""}`}>
          Choose a time
        </h2>
        {servicesLoaded ? renderSlots() : <p className="mt-4 text-sh-gray">Loading…</p>}
      </section>

      <section>
        <h2 className="font-serif text-2xl text-sh-navy">Your details</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="booking-name" className="block text-sm font-medium text-sh-black">
              Name
            </label>
            <input
              id="booking-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-md border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="booking-email" className="block text-sm font-medium text-sh-black">
              Email
            </label>
            <input
              id="booking-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-md border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="booking-phone" className="block text-sm font-medium text-sh-black">
              Phone <span className="text-sh-gray">(optional)</span>
            </label>
            <input
              id="booking-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 min-h-[44px] w-full rounded-md border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="booking-notes" className="block text-sm font-medium text-sh-black">
              What can we help with? <span className="text-sh-gray">(optional)</span>
            </label>
            <textarea
              id="booking-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded-md border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>

          {selected ? (
            <p className="text-sm text-sh-gray">
              Selected:{" "}
              <span className="font-medium text-sh-black">
                {selectedService ? `${selectedService.name} — ` : ""}
                {dayLabelFmt.format(new Date(selected.startsAt))} at{" "}
                {timeFmt.format(new Date(selected.startsAt))}
              </span>
            </p>
          ) : (
            <p className="text-sm text-sh-gray">
              {showSlots ? "Select a time to continue." : "Select a service, then a time."}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !selected}
            className="min-h-[44px] w-full rounded-md bg-sh-navy px-5 py-2.5 text-sm font-medium text-white transition hover:bg-sh-blue disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Booking…" : "Confirm booking"}
          </button>
        </form>
      </section>
    </div>
  );
}

function SlotButton({
  slot,
  selected,
  onSelect,
}: Readonly<{ slot: Slot; selected: boolean; onSelect: (slot: Slot) => void }>) {
  return (
    <button
      type="button"
      onClick={() => onSelect(slot)}
      aria-pressed={selected}
      className={
        selected
          ? "min-h-[44px] rounded-md border border-sh-navy bg-sh-navy px-4 py-2 text-sm font-medium text-white"
          : "min-h-[44px] rounded-md border border-sh-gray/30 bg-white px-4 py-2 text-sm text-sh-black transition hover:border-sh-navy"
      }
    >
      {timeFmt.format(new Date(slot.startsAt))}
    </button>
  );
}
