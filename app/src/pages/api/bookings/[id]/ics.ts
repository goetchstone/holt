// /app/src/pages/api/bookings/[id]/ics.ts
//
// Public single-booking calendar download ("Add to calendar"). Returns a valid
// VCALENDAR/VEVENT for the booking with the attachment headers a browser needs
// to save it as booking.ics. Unauthenticated (the customer has no login), so the
// capability is an HMAC token issued in the create response -- the sequential id
// alone can't gate the file or anyone could enumerate it and harvest every
// customer's name/email/notes.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { buildIcsEvent } from "@/lib/booking/ics";
import { bookingToIcsEvent } from "@/lib/booking/event";
import { verifyBookingToken } from "@/lib/booking/icsToken";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 30 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid booking id" });
  }

  const token = typeof req.query.token === "string" ? req.query.token : undefined;
  if (!verifyBookingToken(id, token)) {
    return res.status(403).json({ error: "Invalid or missing calendar token" });
  }

  try {
    const booking = await prisma.booking.findFirst({
      where: { id, organizationId: DEFAULT_ORG_ID },
      select: {
        id: true,
        customerName: true,
        customerEmail: true,
        serviceType: true,
        notes: true,
        startsAt: true,
        endsAt: true,
      },
    });
    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const settings = await getAppSettings();
    const organizerName = settings.companyName?.trim() || settings.appName;
    const ics = buildIcsEvent(bookingToIcsEvent(booking, { organizerName }));

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="booking.ics"');
    return res.status(200).send(ics);
  } catch (err: unknown) {
    logError("Booking ics export failed", err, { id });
    return res.status(500).json({ error: "Could not generate calendar file" });
  }
});
