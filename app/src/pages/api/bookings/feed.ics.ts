// /app/src/pages/api/bookings/feed.ics.ts
//
// Staff iCal subscription feed. A VCALENDAR of all upcoming (startsAt >= now)
// non-cancelled bookings that staff subscribe to from Google/Outlook/Apple
// Calendar so new bookings appear automatically. Token-gated by ?token=
// against BOOKING_FEED_TOKEN -- if that env var is unset the feed is treated as
// disabled (404) so a misconfigured deployment never leaks bookings publicly.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { buildIcsCalendar } from "@/lib/booking/ics";
import { bookingToIcsEvent } from "@/lib/booking/event";
import { rateLimit } from "@/lib/rateLimit";
import { logError } from "@/lib/logger";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 30 });

export default limiter(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  const expected = process.env.BOOKING_FEED_TOKEN;
  // Feed disabled when no token is configured -- 404 rather than 401 so the
  // endpoint is indistinguishable from "not a route" to an unauthorized client.
  if (!expected) {
    return res.status(404).json({ error: "Not found" });
  }

  const provided = req.query.token;
  if (typeof provided !== "string" || provided !== expected) {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const now = new Date();
    const bookings = await prisma.booking.findMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        status: { in: ["PENDING", "CONFIRMED"] },
        startsAt: { gte: now },
      },
      orderBy: { startsAt: "asc" },
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

    const settings = await getAppSettings();
    const organizerName = settings.companyName?.trim() || settings.appName;
    const ics = buildIcsCalendar(bookings.map((b) => bookingToIcsEvent(b, { organizerName })));

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    return res.status(200).send(ics);
  } catch (err: unknown) {
    logError("Booking feed export failed", err);
    return res.status(500).json({ error: "Could not generate calendar feed" });
  }
});
