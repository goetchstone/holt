// /app/src/server/trpc/context.ts
//
// tRPC request context for the App Router fetch adapter. Session is read from
// the JWT (next-auth v4, session strategy = "jwt") via getToken, which decrypts
// the session cookie off the raw Request — the reliable way to read a v4
// session outside the Pages Router req/res world. The jwt callback in
// [...nextauth].ts puts `id` and `role` on the token, so they're available here
// without a DB hit. The sh-impersonate cookie is surfaced for role procedures.

import { getToken } from "next-auth/jwt";

export interface TrpcContext {
  userId: string | null;
  /** Email from the JWT — used for createdBy/updatedBy audit fields. */
  userEmail: string | null;
  /** Role carried on the JWT (may be stale vs DB; role procedures re-resolve). */
  tokenRole: string | null;
  impersonate: string | null;
  headers: Headers;
}

function readImpersonateCookie(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "sh-impersonate") return decodeURIComponent(rest.join("="));
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
    tokenRole: (token?.role as string | undefined) ?? null,
    impersonate: readImpersonateCookie(req),
    headers: req.headers,
  };
}
