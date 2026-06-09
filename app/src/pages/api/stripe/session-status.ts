// /app/src/pages/api/stripe/session-status.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getStripe } from "@/lib/stripe";
import { success, badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { rateLimit } from "@/lib/rateLimit";

// Public payment-polling endpoint: the success page hits it after the Stripe
// redirect to learn if the charge cleared. It returns ONLY the payment status —
// never customer_email / orderId / orderno. Those are PII, and Stripe session ids
// are exposed client-side, so returning them let any visitor read another
// customer's email + order via a guessed session id. Rate-limited as well.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const { session_id } = req.query;
  if (!session_id || typeof session_id !== "string") {
    return badRequest(res, "session_id query parameter is required");
  }

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id);
    return success(res, {
      status: session.status,
      payment_status: session.payment_status,
    });
  } catch (err) {
    return handleError(res, err, "GET /stripe/session-status");
  }
}

export default rateLimit({ windowMs: 60_000, maxRequests: 30 })(handler);
