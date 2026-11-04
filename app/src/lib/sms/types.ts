// /app/src/lib/sms/types.ts
//
// The provider-neutral text-message seam (GAP-12), shaped like
// lib/payments/types.ts: what the rest of Holt asks of a provider, taken from
// what it actually needs. Adding one means a new id here, a module implementing
// `SmsProvider`, an entry in INTEGRATION_PROVIDERS (its credentials) and a case
// in lib/sms/index.ts. Nothing else in the app should learn its name.

export type SmsProviderId = "twilio";

export interface SmsSendRequest {
  /** E.164 (lib/sms/phone.ts). */
  to: string;
  body: string;
  /** Where the provider reports delivery, when this deployment can be reached. */
  statusCallbackUrl?: string;
}

export type SmsSendResult =
  | { outcome: "accepted"; providerMessageId: string }
  /** No provider set up: the row stays queued, and goes once one is. */
  | { outcome: "not-configured" }
  | {
      outcome: "refused";
      error: string;
      /** Trying again can't help: a bad number, or one that replied STOP. */
      permanent: boolean;
      /** The provider says this number replied STOP to us. */
      recipientOptedOut: boolean;
    };

/** Everything a provider might need to authenticate a webhook. */
export interface SmsWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  /** The absolute URL the provider delivered to. */
  requestUrl: string;
  params: Record<string, unknown>;
}

/** What a webhook said, once it is known to be genuine. */
export type SmsWebhookEvent =
  | { kind: "opt-out"; phone: string }
  | { kind: "opt-in"; phone: string }
  | { kind: "delivered"; providerMessageId: string }
  | { kind: "undelivered"; providerMessageId: string; error: string }
  | { kind: "other" };

export interface SmsProvider {
  readonly id: SmsProviderId;
  readonly displayName: string;
  isConfigured(): Promise<boolean>;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
  /** The cheapest real call that proves the credentials work. Sends nothing. */
  testConnection(): Promise<{ ok: boolean; message: string }>;
  verifyWebhook(request: SmsWebhookRequest): Promise<boolean>;
  parseWebhook(params: Record<string, unknown>): SmsWebhookEvent;
}
