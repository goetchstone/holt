// /app/src/pages/api/bookings/index.ts
//
// Bookings collection.
//   POST (public)  -- create a booking from the public /book flow. Rate-limited,
//                     validated via parseBookingInput, with a race guard that
//                     rejects a slot already taken by another booking.
//   GET  (ADMIN)   -- list bookings newest-first for the back-office.
//
// The two methods have different auth surfaces (public create vs. admin list),
// so method dispatch happens at the top: GET is delegated to the requireAuthWithRole
// wrapper; POST runs through the public rate limiter. The create logic lives in
// createBooking so the POST handler stays thin (CLAUDE.md rule 14).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { rateLimit } from "@/lib/rateLimit";
import { parseBookingInput } from "@/lib/booking/requestBody";
import { signBookingId } from "@/lib/booking/icsToken";
import { enqueueAndSend } from "@/lib/email/queue";
import { bookingConfirmationEmail } from "@/lib/email/templates";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

// Booking submissions should be infrequent per visitor.
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 10 });

const listBookings = requireAuthWithRole(
  ["ADMIN"],
  async (_req: NextApiRequest, res: NextApiResponse) => {
    const bookings = await prisma.booking.findMany({
      where: { organizationId: DEFAULT_ORG_ID },
      orderBy: { startsAt: "desc" },
      select: {
        id: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        serviceType: true,
        startsAt: true,
        endsAt: true,
        notes: true,
        status: true,
      },
    });
    return res.status(200).json({ bookings });
  },
);

const createBooking = limiter(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    const input = parseBookingInput(req.body);

    // When a catalog Service is chosen, trust its duration for the slot end and
    // use its name as the label -- the client-sent endsAt is advisory.
    let endsAt = input.endsAt;
    let serviceType = input.serviceType ?? null;
    let serviceId: number | null = null;
    if (input.serviceId) {
      const service = await prisma.service.findFirst({
        where: { id: input.serviceId, organizationId: DEFAULT_ORG_ID, isActive: true },
        select: { id: true, name: true, durationMinutes: true },
      });
      if (service) {
        serviceId = service.id;
        serviceType = service.name;
        endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000);
      }
    }

    // Race guard: reject if a non-cancelled booking already overlaps this slot.
    // Half-open overlap -- existing.start < new.end AND existing.end > new.start.
    const conflict = await prisma.booking.findFirst({
      where: {
        organizationId: DEFAULT_ORG_ID,
        status: { in: ["PENDING", "CONFIRMED"] },
        startsAt: { lt: endsAt },
        endsAt: { gt: input.startsAt },
      },
      select: { id: true },
    });
    if (conflict) {
      return res.status(409).json({ error: "That time was just taken. Please pick another slot." });
    }

    const booking = await prisma.booking.create({
      data: {
        organizationId: DEFAULT_ORG_ID,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone ?? null,
        serviceType,
        serviceId,
        startsAt: input.startsAt,
        endsAt,
        notes: input.notes ?? null,
        status: "PENDING",
        createdBy: input.customerEmail,
      },
    });

    // Best-effort confirmation email -- enqueued + sent without blocking the
    // response; the durable row is retried by the drain cron if SMTP is down.
    const settings = await getAppSettings();
    const confirmation = bookingConfirmationEmail({
      appName: settings.appName,
      customerName: input.customerName,
      serviceName: serviceType,
      startsAt: input.startsAt,
      timezone: settings.timezone,
    });
    enqueueAndSend({
      to: input.customerEmail,
      subject: confirmation.subject,
      html: confirmation.html,
      templateKey: "booking-confirmation",
      createdBy: input.customerEmail,
    });

    return res.status(201).json({ booking: { ...booking, icsToken: signBookingId(booking.id) } });
  } catch (err: unknown) {
    logError("Booking create failed", err);
    return res.status(400).json({ error: getErrorMessage(err, "Could not create booking") });
  }
});

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return listBookings(req, res);
  if (req.method === "POST") return createBooking(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: "Method not allowed" });
}
