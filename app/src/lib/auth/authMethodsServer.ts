// /app/src/lib/auth/authMethodsServer.ts
//
// Server-side reader for which sign-in methods a deployment has enabled,
// derived from environment configuration. Deliberately imports ONLY the
// client-safe catalog (./authMethods) — never prisma or next-auth/providers —
// so a client page can call getEnabledAuthMethods() from getServerSideProps
// without dragging server-only modules into the browser bundle. The actual
// provider construction (which needs prisma + the next-auth provider modules)
// lives in authProviders.ts, imported only by the NextAuth handler.

import { resolveEnabledAuthMethods, type AuthMethodDef, type AuthMethodFlags } from "./authMethods";

function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Read sign-in-method enablement flags from process.env. Server-only. */
export function authMethodFlagsFromEnv(): AuthMethodFlags {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    okta: Boolean(
      process.env.OKTA_CLIENT_ID && process.env.OKTA_CLIENT_SECRET && process.env.OKTA_ISSUER,
    ),
    azureAd: Boolean(
      process.env.AZURE_AD_CLIENT_ID &&
      process.env.AZURE_AD_CLIENT_SECRET &&
      process.env.AZURE_AD_TENANT_ID,
    ),
    local: envFlag(process.env.AUTH_LOCAL_ENABLED),
  };
}

/**
 * Methods to advertise on the sign-in page. Same shape the login page renders
 * from. No secrets included — only ids + labels.
 */
export function getEnabledAuthMethods(): AuthMethodDef[] {
  return resolveEnabledAuthMethods(authMethodFlagsFromEnv());
}
