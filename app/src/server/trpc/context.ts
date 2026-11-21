// /app/src/server/trpc/context.ts
//
// tRPC request context for the App Router fetch adapter. Session is read from
// the JWT (next-auth v4, session strategy = "jwt") via getToken, which decrypts
// the session cookie off the raw Request — the reliable way to read a v4
// session outside the Pages Router req/res world. The jwt callback in
// [...nextauth].ts puts `id` on the token, so it is available here without a DB
// hit. The holt-impersonate cookie is surfaced for the gates.
//
// The token's `role` is deliberately NOT surfaced. It is the role at sign-in,
// stale after a re-role and blind to isActive, and two report decisions once
// read it from here (the wealth columns and Sales by Salesperson's scope) when
// every gate re-reads the staff row. Without the field a procedure that reaches
// for it is a compile error (role-list sweep, 2026-11-21).

import { getToken } from "next-auth/jwt";

export interface TrpcContext {
  userId: string | null;
  /** Email from the JWT — used for createdBy/updatedBy audit fields. */
  userEmail: string | null;
  impersonate: string | null;
  headers: Headers;
}

function readImpersonateCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "holt-impersonate") return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function createContext({ req }: { req: Request }): Promise<TrpcContext> {
  // getToken accepts the web Request in next-auth v4.24+; it reads the session
  // cookie from req headers and verifies it with NEXTAUTH_SECRET.
  const token = await getToken({
    req: req as unknown as Parameters<typeof getToken>[0]["req"],
    secret: process.env.NEXTAUTH_SECRET,
  });

  return {
    userId: (token?.id as string | undefined) ?? null,
    userEmail: (token?.email as string | undefined) ?? null,
    impersonate: readImpersonateCookie(req),
    headers: req.headers,
  };
}
