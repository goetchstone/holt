// /app/src/lib/booking/loadSlots.ts
//
// Single source of truth for "which slots are bookable right now." Both the
// public availability endpoint (what the picker shows) and the public create
// endpoint (what a POST is allowed to book) call loadAvailableSlots, so the two
// can never disagree about whether a given start time is offered. Previously the
// availability logic lived only in the GET handler and create did no slot check
// at all -- a POST could book a past or off-hours time the picker never showed.
//
// Mode selection mirrors the availability endpoint exactly:
//   - Service mode (serviceId + an active service + configured windows): slots
//     from the AvailabilityWindows, stepped by the service duration (+buffer).
//   - Flat fallback (otherwise): the business-hours generator from
//     AppSettings.bookingConfig.
// Both subtract existing PENDING/CONFIRMED bookings and calendar blocks, and the
// generators drop past slots.

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { generateSlots, type BusyInterval, type Slot } from "@/lib/booking/slots";
import { computeWindowSlots } from "@/lib/booking/availability";

export interface LoadAvailableSlotsInput {
  /** Chosen service, or null for the flat business-hours fallback. */
  serviceId: number | null;
  /** Reference "now"; past slots are dropped relative to this. */
  now: Date;
}

export async function loadAvailableSlots(input: LoadAvailableSlotsInput): Promise<Slot[]> {
  const { serviceId, now } = input;
  const { bookingConfig: cfg } = await getAppSettings();
  const windowEnd = new Date(now.getTime() + cfg.windowDays * 24 * 60 * 60 * 1000);

  // Busy = active bookings + calendar blocks overlapping the window.
  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        status: { in: ["PENDING", "CONFIRMED"] },
        endsAt: { gt: now },
        startsAt: { lt: windowEnd },
      },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.calendarBlock.findMany({
      where: { organizationId: DEFAULT_ORG_ID, endsAt: { gt: now }, startsAt: { lt: windowEnd } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  const busy: BusyInterval[] = [...bookings, ...blocks];

  // Service mode: use the configured windows when the service + windows exist.
  if (serviceId && Number.isInteger(serviceId)) {
    const service = await prisma.service.findFirst({
      where: { id: serviceId, organizationId: DEFAULT_ORG_ID, isActive: true },
      select: { durationMinutes: true, bufferMinutes: true },
    });
    if (service) {
      const windows = await prisma.availabilityWindow.findMany({
        where: { organizationId: DEFAULT_ORG_ID, OR: [{ serviceId: null }, { serviceId }] },
        select: { dayOfWeek: true, startTime: true, endTime: true },
      });
      if (windows.length > 0) {
        return computeWindowSlots({
          fromDate: now,
          windowDays: cfg.windowDays,
          durationMinutes: service.durationMinutes,
          bufferMinutes: service.bufferMinutes,
          windows,
          busy,
        });
      }
    }
  }

  // Flat fallback.
  return generateSlots({
    fromDate: now,
    days: cfg.windowDays,
    startHour: cfg.startHour,
    endHour: cfg.endHour,
    slotMinutes: cfg.slotMinutes,
    busy,
  });
}

// Pure membership check: is `startsAt` the start of one of the offered slots?
// Compared to the millisecond, because the picker echoes back the exact ISO
// start it was given. Rejecting a non-match rejects past times, off-hours times,
// and times inside a busy interval in one check -- none of those are generated.
export function slotsIncludeStart(startsAt: Date, slots: Slot[]): boolean {
  const target = startsAt.getTime();
  return slots.some((s) => s.startsAt.getTime() === target);
}
