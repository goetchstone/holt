// /app/src/lib/sms/twilio.ts
//
// Twilio behind the SmsProvider seam (GAP-12). One REST call to send, so no SDK:
// POST /2010-04-01/Accounts/{sid}/Messages.json, form-encoded, HTTP Basic.
// Credentials are DB-first, env fallback, like SMTP's (Settings > Integrations).
//
// Webhooks are signed: HMAC-SHA1, keyed by the auth token, over the URL Twilio
// called followed by each POST parameter's name and value, sorted by name, as
// base64 (twilio-node src/webhooks/webhooks.ts). The same route gets a customer's
// replies and delivery reports. A STOP is handled by Twilio itself, which also
// answers it; Holt records it so its own screens and queue agree.

import { createHmac, timingSafeEqual } from "crypto";
import { resolveCredential } from "@/lib/integrationCredentials";
import { isE164 } from "./phone";
import type {
  SmsProvider,
  SmsSendRequest,
  SmsSendResult,
  SmsWebhookEvent,
  SmsWebhookRequest,
} from "./types";

const API_BASE = "https://api.twilio.com/2010-04-01";
const TIMEOUT_MS = 15_000;

/** Twilio's error for a number that replied STOP to this sender. */
const UNSUBSCRIBED_RECIPIENT = 21610;

/** Twilio's default keywords. YES isn't an opt-in here: it doesn't lift the block on a toll-free number. */
const OPT_OUT_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
const OPT_IN_WORDS = new Set(["START", "UNSTOP"]);

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
}

async function twilioConfig(): Promise<TwilioConfig | null> {
  const accountSid = await resolveCredential("twilio", "accountSid", "TWILIO_ACCOUNT_SID");
  const authToken = await resolveCredential("twilio", "authToken", "TWILIO_AUTH_TOKEN");
  const fromNumber = await resolveCredential("twilio", "fromNumber", "TWILIO_FROM_NUMBER");
  const messagingServiceSid = await resolveCredential(
    "twilio",
    "messagingServiceSid",
    "TWILIO_MESSAGING_SERVICE_SID",
  );
  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) return null;
  return { accountSid, authToken, fromNumber, messagingServiceSid };
}

function basicAuth(config: TwilioConfig): string {
  const pair = `${config.accountSid}:${config.authToken}`;
  return `Basic ${Buffer.from(pair).toString("base64")}`;
}

function accountUrl(config: TwilioConfig, suffix: string): string {
  return `${API_BASE}/Accounts/${encodeURIComponent(config.accountSid)}${suffix}`;
}

async function send(request: SmsSendRequest): Promise<SmsSendResult> {
  const config = await twilioConfig();
  if (!config) return { outcome: "not-configured" };
  const form = new URLSearchParams({ To: request.to, Body: request.body });
  // A Messaging Service picks its own sender, and is what a registered campaign uses.
  if (config.messagingServiceSid) form.set("MessagingServiceSid", config.messagingServiceSid);
  else if (config.fromNumber) form.set("From", config.fromNumber);
  if (request.statusCallbackUrl) form.set("StatusCallback", request.statusCallbackUrl);
  try {
    const res = await fetch(accountUrl(config, "/Messages.json"), {
      method: "POST",
      headers: {
        Authorization: basicAuth(config),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as {
      sid?: string;
      code?: number;
      message?: string;
    };
    if (res.ok && data.sid) return { outcome: "accepted", providerMessageId: data.sid };
    return {
      outcome: "refused",
      error: `Twilio ${data.code ?? res.status}: ${data.message ?? "the send was refused"}`,
      // A 400 is about this message, so sending it again changes nothing. Anything
      // else is about the moment or the account: a 401 is a rotated token, and
      // the queued texts should still go once the new one is entered.
      permanent: res.status === 400,
      recipientOptedOut: data.code === UNSUBSCRIBED_RECIPIENT,
    };
  } catch (err) {
    return {
      outcome: "refused",
      error: err instanceof Error ? err.message : "Twilio could not be reached",
      permanent: false,
      recipientOptedOut: false,
    };
  }
}

async function testConnection(): Promise<{ ok: boolean; message: string }> {
  const config = await twilioConfig();
  if (!config) {
    return {
      ok: false,
      message:
        "Twilio needs an Account SID, an Auth Token, and a From Number or Messaging Service.",
    };
  }
  try {
    const res = await fetch(accountUrl(config, ".json"), {
      headers: { Authorization: basicAuth(config) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: `Twilio test failed: HTTP ${res.status}` };
    const data = (await res.json()) as { friendly_name?: string; status?: string };
    if (data.status !== "active") {
      return { ok: false, message: `The Twilio account is ${data.status ?? "not active"}.` };
    }
    return { ok: true, message: `Authenticated: ${data.friendly_name ?? config.accountSid}.` };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    return { ok: false, message: `Twilio test failed: ${why}` };
  }
}

/** What Twilio signs for one parameter: its name and value, or each of several values, deduplicated and sorted. */
function signedParam(name: string, value: unknown): string {
  if (Array.isArray(value)) {
    return [...new Set(value.map(String))]
      .sort()
      .map((v) => name + v)
      .join("");
  }
  return name + String(value);
}

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + signedParam(key, params[key]), url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

async function verifyWebhook(request: SmsWebhookRequest): Promise<boolean> {
  const authToken = await resolveCredential("twilio", "authToken", "TWILIO_AUTH_TOKEN");
  const provided = request.headers["x-twilio-signature"];
  if (!authToken || typeof provided !== "string") return false;
  const expected = Buffer.from(twilioSignature(authToken, request.requestUrl, request.params));
  const given = Buffer.from(provided);
  // timingSafeEqual throws on a length mismatch rather than answering false.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDelivery(params: Record<string, unknown>): SmsWebhookEvent {
  const providerMessageId = text(params.MessageSid);
  const status = text(params.MessageStatus);
  if (!providerMessageId) return { kind: "other" };
  if (status === "delivered") return { kind: "delivered", providerMessageId };
  if (status === "undelivered" || status === "failed") {
    const code = text(params.ErrorCode);
    return {
      kind: "undelivered",
      providerMessageId,
      error: code ? `Twilio ${code}: the carrier didn't deliver it` : `Twilio: ${status}`,
    };
  }
  return { kind: "other" };
}

function parseWebhook(params: Record<string, unknown>): SmsWebhookEvent {
  if (text(params.MessageStatus)) return parseDelivery(params);
  const phone = text(params.From);
  if (!isE164(phone)) return { kind: "other" };
  // OptOutType comes with Advanced Opt-Out, whose keywords the store can change.
  const type = text(params.OptOutType).toUpperCase();
  const word = text(params.Body).toUpperCase();
  if (type === "STOP" || (!type && OPT_OUT_WORDS.has(word))) return { kind: "opt-out", phone };
  if (type === "START" || (!type && OPT_IN_WORDS.has(word))) return { kind: "opt-in", phone };
  return { kind: "other" };
}

export const twilioProvider: SmsProvider = {
  id: "twilio",
  displayName: "Twilio",
  isConfigured: async () => (await twilioConfig()) !== null,
  send,
  testConnection,
  verifyWebhook,
  parseWebhook,
};
