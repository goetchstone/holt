// /app/src/pages/api/sms/twilio/webhook.ts
//
// POST -- Twilio's delivery endpoint for a customer's replies (STOP, START) and
// delivery reports (GAP-12). Public, like the Stripe and Square webhooks: the
// signature is the authorization, and a request without a good one changes
// nothing. Twilio signs the URL it called, so this builds it from NEXTAUTH_URL,
// which must match what is set on the number in Twilio's console. Next's body
// parser has already read the form into req.body, and Twilio signs its values.

import type { NextApiRequest, NextApiResponse } from "next";
import { logError } from "@/lib/logger";
import { getSmsProvider } from "@/lib/sms";
import { applySmsWebhookEvent } from "@/lib/sms/webhook";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const provider = getSmsProvider("twilio");
  const params = (req.body ?? {}) as Record<string, unknown>;
  const baseUrl = (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
  const genuine = await provider.verifyWebhook({
    headers: req.headers,
    requestUrl: `${baseUrl}${req.url ?? "/api/sms/twilio/webhook"}`,
    params,
  });
  if (!genuine) return res.status(403).json({ error: "Bad signature" });
  try {
    await applySmsWebhookEvent(provider.parseWebhook(params));
  } catch (err) {
    // Not a 200: this shows in Twilio's debugger, and goes to a fallback URL if the
    // store set one. If a STOP is lost anyway, the next send's 21610 records it.
    logError("Twilio webhook could not be applied", err);
    return res.status(500).json({ error: "Could not record the webhook" });
  }
  // An empty answer: Twilio itself answers a STOP, and Holt has nothing to say.
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send("<Response></Response>");
}
