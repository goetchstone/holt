// /app/src/lib/auth/authProviders.ts
//
// Server-only assembly of the NextAuth provider array. OAuth keys resolve
// DB-first with an env fallback (resolveCredential): a value entered in
// Settings -> Integrations wins; otherwise the process env var is used, so
// env-configured / bootstrap deployments keep working unchanged. Per-user local
// passwords live in the database on StaffMember.passwordHash.
//
//   buildAuthProviders()       sync, env-only. Kept for the static authOptions
//                              that getServerSession imports (session validation
//                              never needs the live provider list).
//   buildAuthProvidersAsync()  DB-or-env. Used by the [...nextauth] login handler
//                              per request, so Settings-entered keys take effect
//                              without a redeploy (cached 60s).
//
// A provider is included only when all its required keys resolve. `local` is
// included when AUTH_LOCAL_ENABLED is truthy.
//
// This module is imported only by pages/api/auth/[...nextauth].ts, so the prisma
// + password imports never reach a client bundle.

import GoogleProvider from "next-auth/providers/google";
import OktaProvider from "next-auth/providers/okta";
import AzureADProvider from "next-auth/providers/azure-ad";
import CredentialsProvider from "next-auth/providers/credentials";
import type { Provider } from "next-auth/providers/index";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { resolveCredential } from "@/lib/integrationCredentials";
import { authMethodFlagsFromEnv } from "./authMethodsServer";

/**
 * Authenticate an email + password against a local StaffMember account.
 * Returns the NextAuth user object (keyed by the linked User.id so the existing
 * role-resolution path in the jwt callback works unchanged), or null on any
 * failure. Never throws.
 */
async function authorizeLocal(
  credentials: Record<"email" | "password", string> | undefined,
): Promise<{ id: string; email: string | null; name: string } | null> {
  const email = credentials?.email?.trim().toLowerCase();
  const password = credentials?.password;
  if (!email || !password) return null;

  try {
    const staff = await prisma.staffMember.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, isActive: true },
      select: { userId: true, email: true, displayName: true, passwordHash: true },
    });
    if (!staff?.passwordHash || !staff.userId) return null;
    if (!verifyPassword(password, staff.passwordHash)) return null;
    return { id: staff.userId, email: staff.email, name: staff.displayName };
  } catch {
    return null;
  }
}

const GOOGLE_AUTHORIZATION = {
  params: {
    prompt: "consent",
    access_type: "offline",
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive",
  },
} as const;

function googleProvider(clientId: string, clientSecret: string): Provider {
  return GoogleProvider({ clientId, clientSecret, authorization: GOOGLE_AUTHORIZATION });
}
function oktaProvider(clientId: string, clientSecret: string, issuer: string): Provider {
  return OktaProvider({ clientId, clientSecret, issuer });
}
function azureProvider(clientId: string, clientSecret: string, tenantId: string): Provider {
  return AzureADProvider({ clientId, clientSecret, tenantId });
}
function localProvider(): Provider {
  return CredentialsProvider({
    name: "Email & Password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    authorize: (credentials) =>
      authorizeLocal(credentials as Record<"email" | "password", string> | undefined),
  });
}

/** Build providers from environment configuration only (sync). */
export function buildAuthProviders(): Provider[] {
  const flags = authMethodFlagsFromEnv();
  const providers: Provider[] = [];
  if (flags.google) {
    providers.push(
      googleProvider(process.env.GOOGLE_CLIENT_ID!, process.env.GOOGLE_CLIENT_SECRET!),
    );
  }
  if (flags.okta) {
    providers.push(
      oktaProvider(
        process.env.OKTA_CLIENT_ID!,
        process.env.OKTA_CLIENT_SECRET!,
        process.env.OKTA_ISSUER!,
      ),
    );
  }
  if (flags.azureAd) {
    providers.push(
      azureProvider(
        process.env.AZURE_AD_CLIENT_ID!,
        process.env.AZURE_AD_CLIENT_SECRET!,
        process.env.AZURE_AD_TENANT_ID!,
      ),
    );
  }
  if (flags.local) providers.push(localProvider());
  return providers;
}

let cache: { providers: Provider[]; expires: number } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * Build providers with keys resolved DB-first (Settings) then env, so keys
 * entered in the Settings UI drive login without a redeploy. Cached 60s to keep
 * the per-request /api/auth/* path from re-querying on every session poll.
 */
export async function buildAuthProvidersAsync(): Promise<Provider[]> {
  if (cache && cache.expires > Date.now()) return cache.providers;

  const providers: Provider[] = [];

  const [gId, gSecret] = await Promise.all([
    resolveCredential("google", "clientId", "GOOGLE_CLIENT_ID"),
    resolveCredential("google", "clientSecret", "GOOGLE_CLIENT_SECRET"),
  ]);
  if (gId && gSecret) providers.push(googleProvider(gId, gSecret));

  const [oId, oSecret, oIssuer] = await Promise.all([
    resolveCredential("okta", "clientId", "OKTA_CLIENT_ID"),
    resolveCredential("okta", "clientSecret", "OKTA_CLIENT_SECRET"),
    resolveCredential("okta", "issuer", "OKTA_ISSUER"),
  ]);
  if (oId && oSecret && oIssuer) providers.push(oktaProvider(oId, oSecret, oIssuer));

  const [aId, aSecret, aTenant] = await Promise.all([
    resolveCredential("azure-ad", "clientId", "AZURE_AD_CLIENT_ID"),
    resolveCredential("azure-ad", "clientSecret", "AZURE_AD_CLIENT_SECRET"),
    resolveCredential("azure-ad", "tenantId", "AZURE_AD_TENANT_ID"),
  ]);
  if (aId && aSecret && aTenant) providers.push(azureProvider(aId, aSecret, aTenant));

  if (authMethodFlagsFromEnv().local) providers.push(localProvider());

  cache = { providers, expires: Date.now() + CACHE_TTL_MS };
  return providers;
}

/** Clear the provider cache so a just-saved key takes effect immediately. */
export function invalidateAuthProvidersCache(): void {
  cache = null;
}
