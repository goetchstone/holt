// /app/src/lib/auth/authMethodsResolved.ts
//
// Server-only: which sign-in methods to advertise on the login page, resolved
// DB-first (Settings -> Integrations) with an env fallback -- so OAuth keys
// entered in the UI surface the matching button without a redeploy. Mirrors the
// enablement logic in authProviders.buildAuthProvidersAsync so the button shown
// and the provider actually wired always agree.
//
// Pulls resolveCredential (prisma) but NOT the next-auth provider modules, to
// keep the server-only graph small. Imported ONLY by the login page's
// getServerSideProps (Next strips getServerSideProps-exclusive imports from the
// client bundle), so prisma never reaches the browser. The env-only sibling
// (authMethodsServer.getEnabledAuthMethods) stays prisma-free for any other use.

import { resolveCredential } from "@/lib/integrationCredentials";
import { resolveEnabledAuthMethods, type AuthMethodDef, type AuthMethodFlags } from "./authMethods";
import { authMethodFlagsFromEnv } from "./authMethodsServer";

export async function getEnabledAuthMethodsResolved(): Promise<AuthMethodDef[]> {
  const [gId, gSecret, oId, oSecret, oIssuer, aId, aSecret, aTenant] = await Promise.all([
    resolveCredential("google", "clientId", "GOOGLE_CLIENT_ID"),
    resolveCredential("google", "clientSecret", "GOOGLE_CLIENT_SECRET"),
    resolveCredential("okta", "clientId", "OKTA_CLIENT_ID"),
    resolveCredential("okta", "clientSecret", "OKTA_CLIENT_SECRET"),
    resolveCredential("okta", "issuer", "OKTA_ISSUER"),
    resolveCredential("azure-ad", "clientId", "AZURE_AD_CLIENT_ID"),
    resolveCredential("azure-ad", "clientSecret", "AZURE_AD_CLIENT_SECRET"),
    resolveCredential("azure-ad", "tenantId", "AZURE_AD_TENANT_ID"),
  ]);

  const flags: AuthMethodFlags = {
    google: Boolean(gId && gSecret),
    okta: Boolean(oId && oSecret && oIssuer),
    azureAd: Boolean(aId && aSecret && aTenant),
    local: authMethodFlagsFromEnv().local, // local password is an env flag, not a key
  };
  return resolveEnabledAuthMethods(flags);
}
