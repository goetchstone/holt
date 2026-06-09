// /app/src/lib/auth/authMethods.ts
//
// Client/server contract (CLAUDE.md rule 7) for which sign-in methods a
// deployment offers. The login page renders buttons/forms from the enabled
// list; the NextAuth handler builds its provider array from the same flags.
// No secrets and no server-only imports live here, so it is safe to bundle
// into the browser.
//
// Enablement is environment-driven (see lib/auth/authProviders.ts): OAuth
// providers turn on when their client credentials are present; local
// email+password turns on via AUTH_LOCAL_ENABLED. This file only models the
// catalog and the pure flags->enabled-list mapping so that mapping can be
// unit-tested without touching process.env.

export type AuthMethodType = "oauth" | "credentials";

export interface AuthMethodDef {
  /** NextAuth provider id — must match the provider registered server-side. */
  id: string;
  /** Label shown on the sign-in button / form heading. */
  label: string;
  type: AuthMethodType;
}

export const AUTH_METHODS: readonly AuthMethodDef[] = [
  { id: "google", label: "Google", type: "oauth" },
  { id: "okta", label: "Okta", type: "oauth" },
  { id: "azure-ad", label: "Microsoft", type: "oauth" },
  { id: "credentials", label: "Email & Password", type: "credentials" },
];

export interface AuthMethodFlags {
  google: boolean;
  okta: boolean;
  azureAd: boolean;
  local: boolean;
}

const FLAG_BY_METHOD_ID: Record<string, keyof AuthMethodFlags> = {
  google: "google",
  okta: "okta",
  "azure-ad": "azureAd",
  credentials: "local",
};

/**
 * Map a set of enablement flags to the ordered list of auth methods to offer.
 * Order follows AUTH_METHODS (OAuth first, local last). Pure — same input
 * always yields the same output.
 */
export function resolveEnabledAuthMethods(flags: AuthMethodFlags): AuthMethodDef[] {
  return AUTH_METHODS.filter((m) => flags[FLAG_BY_METHOD_ID[m.id]]);
}

export function isOAuthMethod(method: AuthMethodDef): boolean {
  return method.type === "oauth";
}
