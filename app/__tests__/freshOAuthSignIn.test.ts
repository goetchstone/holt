// /app/__tests__/freshOAuthSignIn.test.ts
//
// The request rewrite that makes an OAuth sign-in a fresh one
// (lib/auth/freshOAuthSignIn.ts). The end-to-end proof, through the real
// NextAuth handler and database, is
// integration/oauthLinkNeedsFreshSignIn.integration.test.ts; this pins which
// requests and which cookies the rewrite touches.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  expiredCookie,
  freshSignInAction,
  isSessionCookie,
  startFreshOAuthSignIn,
} from "@/lib/auth/freshOAuthSignIn";

const types: Record<string, string> = {
  google: "oauth",
  okta: "oauth",
  credentials: "credentials",
};
const typeOf = (id: string) => types[id];

function run(route: string[], cookies: Record<string, string>) {
  const req = { query: { nextauth: route }, cookies } as unknown as NextApiRequest;
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader(name: string, value: unknown) {
      headers[name] = value;
    },
  } as unknown as NextApiResponse;
  startFreshOAuthSignIn(req, res, typeOf);
  return { seen: req.cookies, setCookie: headers["Set-Cookie"] as string[] | undefined };
}

describe("which cookies are the session", () => {
  it.each([
    "next-auth.session-token",
    "__Secure-next-auth.session-token",
    "next-auth.session-token.0",
    "__Secure-next-auth.session-token.12",
    // NextAuth's SessionStore reads every cookie whose name STARTS WITH the
    // session cookie's (core/lib/cookie.js), so these are read as the session too.
    "next-auth.session-tokenx",
    "next-auth.session-token.a",
    "__Secure-next-auth.session-token-extra",
  ])("%s is", (name) => {
    expect(isSessionCookie(name)).toBe(true);
  });

  it.each([
    "next-auth.csrf-token",
    "__Host-next-auth.csrf-token",
    "next-auth.state",
    "next-auth.pkce.code_verifier",
    "next-auth.callback-url",
    "holt-impersonate",
    "x-next-auth.session-token",
  ])("%s is not", (name) => {
    expect(isSessionCookie(name)).toBe(false);
  });
});

describe("which requests get a fresh sign-in", () => {
  it.each([
    [["signin", "google"], "signin"],
    [["callback", "google"], "callback"],
    [["callback", "okta"], "callback"],
    // A provider id nobody configured: the safe side.
    [["callback", "unknown"], "callback"],
  ])("%j does", (route, action) => {
    expect(freshSignInAction(route, typeOf)).toBe(action);
  });

  it.each([
    [["callback", "credentials"]],
    [["signin", "credentials"]],
    [["session"]],
    [["csrf"]],
    [["signout"]],
    [["providers"]],
    [["signin"]],
    [[]],
  ])("%j does not", (route) => {
    expect(freshSignInAction(route, typeOf)).toBeNull();
  });
});

describe("the rewrite", () => {
  const cookies = {
    "next-auth.session-token": "owner",
    "next-auth.session-token.1": "piece",
    "next-auth.state": "state",
    "next-auth.csrf-token": "csrf",
  };

  it("hides the session from an OAuth callback, keeps the rest, and ends it in the reply", () => {
    const { seen, setCookie } = run(["callback", "google"], { ...cookies });
    expect(seen).toEqual({ "next-auth.state": "state", "next-auth.csrf-token": "csrf" });
    expect(setCookie).toEqual([
      expiredCookie("next-auth.session-token"),
      expiredCookie("next-auth.session-token.1"),
    ]);
  });

  it("hides it from the sign-in start, but leaves the browser signed in until the callback", () => {
    const { seen, setCookie } = run(["signin", "google"], { ...cookies });
    expect(Object.keys(seen)).toEqual(["next-auth.state", "next-auth.csrf-token"]);
    expect(setCookie).toBeUndefined();
  });

  it("leaves a password sign-in and a session read as they were", () => {
    for (const route of [["callback", "credentials"], ["session"]]) {
      const { seen, setCookie } = run(route, { ...cookies });
      expect(seen).toEqual(cookies);
      expect(setCookie).toBeUndefined();
    }
  });

  it("writes nothing when there is no session to hide", () => {
    const { setCookie } = run(["callback", "google"], { "next-auth.state": "s" });
    expect(setCookie).toBeUndefined();
  });
});

describe("ending a cookie", () => {
  it("expires it at the root path", () => {
    expect(expiredCookie("next-auth.session-token")).toMatch(
      /^next-auth\.session-token=; Path=\/;.*Max-Age=0/,
    );
  });

  it("marks a __Secure- cookie Secure, or the browser ignores the change", () => {
    expect(expiredCookie("__Secure-next-auth.session-token")).toMatch(/; Secure$/);
    expect(expiredCookie("next-auth.session-token")).not.toMatch(/Secure/);
  });
});
