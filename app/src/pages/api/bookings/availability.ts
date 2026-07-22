// /app/src/pages/api/bookings/availability.ts
//
// Public (no-auth) availability endpoint. The slot computation -- service-window
// mode vs. flat business-hours fallback, minus existing bookings and calendar
// blocks -- lives in lib/booking/loadSlots.ts so this endpoint and the create
// endpoint agree on exactly which slots are bookable.

import type { NextApiRequest, NextApiResponse } from "next";
import { type Slot } from "@/lib/booking/slots";
import { loadAvailableSlots } from "@/lib/booking/loadSlots";
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
    const serviceId =
      typeof req.query.serviceId === "string" && req.query.serviceId
        ? Number(req.query.serviceId)
        : null;
    const slots = await loadAvailableSlots({ serviceId, now: new Date() });
    return res.status(200).json({ slots: toIso(slots) });
  } catch (err: unknown) {
    logError("Booking availability failed", err);
    return res.status(500).json({ error: getErrorMessage(err, "Could not load availability") });
  }
});
