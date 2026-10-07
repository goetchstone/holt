// /app/src/lib/email/config.ts
//
// Resolve SMTP config from the IntegrationCredential store (provider "smtp") or
// env (DB-first, env fallback -- resolveCredential). Returns null when not fully
// configured so the sender can no-op instead of throwing on a fresh deployment.

import { resolveCredential } from "@/lib/integrationCredentials";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  fromAddress: string;
  fromName?: string;
}

export async function getSmtpConfig(orgId: number = DEFAULT_ORG_ID): Promise<SmtpConfig | null> {
  const host = await resolveCredential("smtp", "host", "SMTP_HOST", orgId);
  // From-address falls back to the SMTP username, then env, so a minimal config
  // (host + user + pass) still works.
  const fromAddress =
    (await resolveCredential("smtp", "fromAddress", "EMAIL_FROM", orgId)) ??
    (await resolveCredential("smtp", "user", "SMTP_USER", orgId));
  if (!host || !fromAddress) return null;

  const portStr = (await resolveCredential("smtp", "port", "SMTP_PORT", orgId)) ?? "587";
  const port = Number.parseInt(portStr, 10) || 587;
  const user = await resolveCredential("smtp", "user", "SMTP_USER", orgId);
  const pass = await resolveCredential("smtp", "pass", "SMTP_PASS", orgId);
  const fromName = await resolveCredential("smtp", "fromName", "EMAIL_FROM_NAME", orgId);

  // Port 465 is implicit TLS; 587/25 use STARTTLS (secure: false at connect).
  return { host, port, secure: port === 465, user, pass, fromAddress, fromName };
}

export async function isEmailConfigured(orgId: number = DEFAULT_ORG_ID): Promise<boolean> {
  return (await getSmtpConfig(orgId)) !== null;
}
