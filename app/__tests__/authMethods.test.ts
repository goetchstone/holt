// /app/__tests__/authMethods.test.ts
//
// Pure tests for the sign-in method catalog and the flags->enabled mapping.

import {
  AUTH_METHODS,
  resolveEnabledAuthMethods,
  isOAuthMethod,
  type AuthMethodFlags,
} from "@/lib/auth/authMethods";

const NONE: AuthMethodFlags = { google: false, okta: false, azureAd: false, local: false };

describe("AUTH_METHODS catalog", () => {
  test("declares the four supported methods with unique ids", () => {
    const ids = AUTH_METHODS.map((m) => m.id);
    expect(ids).toEqual(["google", "okta", "azure-ad", "credentials"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only the credentials method is non-oauth", () => {
    expect(AUTH_METHODS.filter((m) => !isOAuthMethod(m)).map((m) => m.id)).toEqual(["credentials"]);
  });
});

describe("resolveEnabledAuthMethods", () => {
  test("returns nothing when no flags are set", () => {
    expect(resolveEnabledAuthMethods(NONE)).toEqual([]);
  });

  test("maps each flag to its method id", () => {
    expect(resolveEnabledAuthMethods({ ...NONE, google: true }).map((m) => m.id)).toEqual([
      "google",
    ]);
    expect(resolveEnabledAuthMethods({ ...NONE, okta: true }).map((m) => m.id)).toEqual(["okta"]);
    expect(resolveEnabledAuthMethods({ ...NONE, azureAd: true }).map((m) => m.id)).toEqual([
      "azure-ad",
    ]);
    expect(resolveEnabledAuthMethods({ ...NONE, local: true }).map((m) => m.id)).toEqual([
      "credentials",
    ]);
  });

  test("preserves catalog order (OAuth first, credentials last) when all enabled", () => {
    const all: AuthMethodFlags = { google: true, okta: true, azureAd: true, local: true };
    expect(resolveEnabledAuthMethods(all).map((m) => m.id)).toEqual([
      "google",
      "okta",
      "azure-ad",
      "credentials",
    ]);
  });
});
