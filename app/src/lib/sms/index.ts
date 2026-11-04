// /app/src/lib/sms/index.ts
//
// The text-message provider registry, the same small switch as
// lib/payments/index.ts. One provider today; when there is a second, which one
// is active becomes a choice in Settings here and nowhere else.

import { twilioProvider } from "./twilio";
import type { SmsProvider, SmsProviderId } from "./types";

export * from "./types";

const PROVIDERS: Record<SmsProviderId, SmsProvider> = { twilio: twilioProvider };

export function getSmsProvider(id: SmsProviderId): SmsProvider {
  return PROVIDERS[id];
}

export function getActiveSmsProvider(): SmsProvider {
  return PROVIDERS.twilio;
}

export function isSmsConfigured(): Promise<boolean> {
  return getActiveSmsProvider().isConfigured();
}
