// /app/src/pages/api/auth/[...nextauth].ts

import type { NextApiRequest, NextApiResponse } from "next";
import NextAuth, { NextAuthOptions } from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { LAST_SEEN_THROTTLE_MS } from "@/lib/loginActivity";
import { buildAuthProviders, buildAuthProvidersAsync } from "@/lib/auth/authProviders";
import { checkRateLimit } from "@/lib/rateLimit";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),

  // In production NextAuth issues __Secure- cookies over HTTPS automatically;
  // set it explicitly so the intent is visible and a misread NODE_ENV can't
  // silently downgrade to insecure cookies.
  useSecureCookies: process.env.NODE_ENV === "production",

  // Providers are assembled from environment configuration (Google / Okta /
  // Azure AD) plus local email+password when AUTH_LOCAL_ENABLED is set. See
  // lib/auth/authProviders.ts.
  providers: buildAuthProviders(),

  pages: { signIn: "/auth/login" },

  session: {
    strategy: "jwt",
  },

  callbacks: {
    async signIn() {
      return true;
    },

    async jwt({ token, account, user }) {
      // Narrow inline so the locals stay non-null inside the block —
      // avoids 6× non-null assertions (S4325). Both `account` and `user`
      // are nullable in NextAuth's types.
      if (account && user) {
        token.accessToken = account.access_token;
        token.id = user.id;
        // Auto-link staff on first sign-in. The jwt callback runs after the
        // PrismaAdapter has committed the User record, so user.id is the
        // persisted database ID. Fire-and-forget -- never blocks sign-in.
        if (user.email) {
          try {
            const alreadyLinked = await prisma.staffMember.findFirst({
              where: { userId: user.id },
            });
            if (!alreadyLinked) {
              const unlinked = await prisma.staffMember.findFirst({
                where: {
                  email: { equals: user.email, mode: "insensitive" },
                  userId: null,
                },
              });
              if (unlinked) {
                await prisma.staffMember.update({
                  where: { id: unlinked.id },
                  data: { userId: user.id },
                });
              }
            }
          } catch {
            // Never block sign-in due to staff-linking errors
          }
        }
        // Stamp lastLoginAt + lastSeenAt for the fresh sign-in. updateMany
        // is a no-op if the user has no StaffMember record (no rows match);
        // never block sign-in.
        try {
          await prisma.staffMember.updateMany({
            where: { userId: user.id },
            data: { lastLoginAt: new Date(), lastSeenAt: new Date() },
          });
          token.lastSeenBumpedAt = Date.now();
        } catch {
          // Never block sign-in
        }
      }
      // Attach staff role so it's available in session
      if (token.id) {
        try {
          const staff = await prisma.staffMember.findFirst({
            where: { userId: token.id as string },
            select: { role: true },
          });
          token.role = staff?.role || "DESIGNER";
        } catch {
          // Default to DESIGNER if lookup fails
          if (!token.role) token.role = "DESIGNER";
        }
      }
      // Bump lastSeenAt for non-sign-in requests (the jwt callback fires on
      // every authenticated request when the JWT is decoded). Throttled via
      // a JWT-side timestamp so we hit the DB at most once per minute per
      // user. The token is encrypted and round-trips on every request, so
      // this is server-state-free. The fresh-sign-in path already stamped
      // lastSeenAt above; skip via the lastBump check naturally — we don't
      // need a separate guard.
      if (token.id) {
        const now = Date.now();
        const lastBump = (token.lastSeenBumpedAt as number | undefined) ?? 0;
        if (now - lastBump > LAST_SEEN_THROTTLE_MS) {
          try {
            await prisma.staffMember.updateMany({
              where: { userId: token.id as string },
              data: { lastSeenAt: new Date(now) },
            });
            token.lastSeenBumpedAt = now;
          } catch {
            // Never block request flow on a presence ping
          }
        }
      }
      return token;
    },

    async session({ session, token }) {
      if (token.accessToken) {
        (session as any).accessToken = token.accessToken;
      }
      if (session.user && token.id) {
        (session.user as any).id = token.id;
      }
      if (token.role) {
        (session as any).role = token.role;
      }
      return session;
    },
  },

  secret: process.env.NEXTAUTH_SECRET,
};

// Login handler resolves providers DB-first (Settings) then env, per request, so
// OAuth keys entered in Settings -> Integrations take effect without a redeploy.
// getServerSession callers keep importing the static `authOptions` above —
// session validation uses the secret + callbacks, not the live provider list.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Throttle ONLY the credentials-callback POST (the password sign-in attempt)
  // — not session reads or OAuth flows. 10 attempts / 15 min per client IP
  // blunts password brute-forcing on local accounts. The dedicated bucket
  // keeps this counter separate from other rate-limited routes.
  const route = Array.isArray(req.query.nextauth) ? req.query.nextauth.join("/") : "";
  if (req.method === "POST" && route === "callback/credentials") {
    if (!checkRateLimit(req, res, { windowMs: 15 * 60_000, maxRequests: 10 }, "login")) return;
  }
  const providers = await buildAuthProvidersAsync();
  return NextAuth(req, res, { ...authOptions, providers });
}
