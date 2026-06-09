// /app/src/lib/booking/event.ts
//
// Maps a persisted booking row into the IcsEventInput shape (CLAUDE.md rule 6:
// shared between the single-booking .ics download and the staff iCal feed so
// the event content stays identical across both). Pure -- no I/O.

import type { IcsEventInput } from "@/lib/booking/ics";

// The booking fields the calendar export needs. Keeping this narrow (vs. the
// full Prisma Booking type) lets callers pass a select-ed subset.
export interface BookableBooking {
  id: number;
  customerName: string;
  customerEmail: string;
  serviceType: string | null;
  notes: string | null;
  startsAt: Date;
  endsAt: Date;
}

export interface BookingEventContext {
  /** Branding name used for the organizer + summary suffix. */
  organizerName: string;
  /** Optional physical location line. */
  location?: string;
}

// Stable, globally-unique UID per booking so calendars dedupe re-imports of the
// same event instead of creating duplicates.
export function bookingUid(id: number, organizerName: string): string {
  const domain = organizerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `booking-${id}@${domain || "holt"}`;
}

export function bookingToIcsEvent(
  booking: BookableBooking,
  ctx: BookingEventContext,
): IcsEventInput {
  const summary = booking.serviceType
    ? `${booking.serviceType} with ${ctx.organizerName}`
    : `Appointment with ${ctx.organizerName}`;

  const descriptionParts = [`Booking for ${booking.customerName}`];
  if (booking.notes) descriptionParts.push(booking.notes);

  return {
    uid: bookingUid(booking.id, ctx.organizerName),
    start: booking.startsAt,
    end: booking.endsAt,
    summary,
    description: descriptionParts.join("\n"),
    location: ctx.location,
    organizerName: ctx.organizerName,
    attendeeEmail: booking.customerEmail,
  };
}
