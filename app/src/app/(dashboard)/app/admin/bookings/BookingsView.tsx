// /app/src/app/(dashboard)/app/admin/bookings/BookingsView.tsx
//
// Lists bookings (newest-first) from /api/bookings and shows the staff iCal
// subscription feed URL with a copy button and instructions. Client component;
// the feed URL (including its token) is supplied by the ADMIN-gated server page.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface BookingRow {
  id: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  serviceType: string | null;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  status: "PENDING" | "CONFIRMED" | "CANCELLED";
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const STATUS_STYLES: Record<BookingRow["status"], string> = {
  PENDING: "bg-sh-gold/20 text-sh-gold",
  CONFIRMED: "bg-green-100 text-green-800",
  CANCELLED: "bg-black/5 text-sh-gray",
};

export function BookingsView({ feedUrl }: Readonly<{ feedUrl: string | null }>) {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bookings");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load bookings");
      const data = (await res.json()) as { bookings: BookingRow[] };
      setBookings(data.bookings);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load bookings"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyFeed() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      toast.success("Feed URL copied");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not copy the URL"));
    }
  }

  function renderBookings() {
    if (loading) return <p className="text-sh-gray">Loading…</p>;
    if (bookings.length === 0) return <p className="text-sh-gray">No bookings yet.</p>;
    return (
      <div className="overflow-hidden rounded-md border border-black/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-sh-stripe text-sh-gray">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <BookingRowItem key={b.id} booking={b} />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-6">
      <h1 className="text-2xl font-semibold text-sh-blue">Bookings</h1>

      <section className="mt-6 rounded-md border border-sh-gray/20 bg-sh-linen p-5">
        <h2 className="text-lg font-semibold text-sh-black">Staff calendar subscription</h2>
        {feedUrl ? (
          <>
            <p className="mt-1 text-sm text-sh-gray">
              Subscribe to this iCal feed in Google, Outlook, or Apple Calendar to see new bookings
              automatically. Add it as a calendar &ldquo;from URL&rdquo; (not a one-time import) so
              it keeps refreshing.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="flex-1 truncate rounded border border-sh-gray/20 bg-white px-3 py-2 text-xs text-sh-black">
                {feedUrl}
              </code>
              <button
                type="button"
                onClick={copyFeed}
                className="min-h-[44px] rounded-md bg-sh-navy px-4 py-2 text-sm font-medium text-white transition hover:bg-sh-blue"
              >
                Copy URL
              </button>
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-sh-gray">
            The subscription feed is disabled. Set the{" "}
            <code className="rounded bg-white px-1 py-0.5 text-xs">BOOKING_FEED_TOKEN</code>{" "}
            environment variable to enable a secure staff feed URL.
          </p>
        )}
      </section>

      <div className="mt-8">{renderBookings()}</div>
    </div>
  );
}

function BookingRowItem({ booking }: Readonly<{ booking: BookingRow }>) {
  return (
    <tr className="border-t border-black/5 align-top">
      <td className="px-4 py-2 text-sh-black">{dateTimeFmt.format(new Date(booking.startsAt))}</td>
      <td className="px-4 py-2 text-sh-black">
        {booking.customerName}
        {booking.serviceType ? (
          <span className="block text-xs text-sh-gray">{booking.serviceType}</span>
        ) : null}
      </td>
      <td className="px-4 py-2 text-sh-gray">
        {booking.customerEmail}
        {booking.customerPhone ? (
          <span className="block text-xs">{booking.customerPhone}</span>
        ) : null}
      </td>
      <td className="px-4 py-2">
        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[booking.status]}`}>
          {booking.status.charAt(0) + booking.status.slice(1).toLowerCase()}
        </span>
      </td>
    </tr>
  );
}
