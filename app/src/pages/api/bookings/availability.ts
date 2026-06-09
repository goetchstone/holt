// /app/src/pages/api/bookings/availability.ts
//
// Public (no-auth) availability endpoint. Two modes, both subtracting existing
// PENDING/CONFIRMED bookings AND calendar blocks (time off / closures):
//   - Service mode (?serviceId): slots come from the configured Availability
//     windows, stepped by the service's duration (+buffer). Used once a Service
//     catalog + windows exist (lib/booking/availability.ts).
//   - Flat mode (no serviceId, or a service with no windows): the legacy
//     business-hours generator from AppSettings.bookingConfig
//     (lib/booking/slots.ts). Keeps zero-config deployments working.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { generateSlots, type BusyInterval, type Slot } from "@/lib/booking/slots";
import { computeWindowSlots } from "@/lib/booking/availability";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 60 });

function toIso(slots: Slot[]) {
  return slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() }));
}

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    const { bookingConfig: cfg } = await getAppSettings();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + cfg.windowDays * 24 * 60 * 60 * 1000);
    const serviceId =
      typeof req.query.serviceId === "string" && req.query.serviceId
        ? Number(req.query.serviceId)
        : null;

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
          const slots = computeWindowSlots({
            fromDate: now,
            windowDays: cfg.windowDays,
            durationMinutes: service.durationMinutes,
            bufferMinutes: service.bufferMinutes,
            windows,
            busy,
          });
          return res.status(200).json({ slots: toIso(slots) });
        }
      }
    }

    // Flat fallback.
    const slots = generateSlots({
      fromDate: now,
      days: cfg.windowDays,
      startHour: cfg.startHour,
      endHour: cfg.endHour,
      slotMinutes: cfg.slotMinutes,
      busy,
    });
    return res.status(200).json({ slots: toIso(slots) });
  } catch (err: unknown) {
    logError("Booking availability failed", err);
    return res.status(500).json({ error: getErrorMessage(err, "Could not load availability") });
  }
});
