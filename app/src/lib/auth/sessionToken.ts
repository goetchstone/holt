// /app/src/lib/auth/sessionToken.ts
//
// GAP-27, the server half of automatic sign-out (lib/auth/idleLogoff.ts).
//
// The session is a NextAuth JWT, and every reader -- getServerSession behind the
// API gates, getToken behind requirePage and the tRPC context, and the routes
// that call getServerSession themselves -- refuses a token past its `exp`. So
// the idle time is enforced in one place, here, by setting `exp` from when the
// person was last active instead of from now. A guard needs no check of its own,
// and one added later is covered without anyone remembering to.
//
// `lastActiveAt` moves only when the browser reports a person at the screen
// (the session "update" call IdleLogoff makes) and at sign-in. A background
// request re-issues the token with the same `lastActiveAt`, so its `exp` stays
// put however often the screen polls.

import { encode, type JWT, type JWTEncodeParams } from "next-auth/jwt";
import { getAppSettings } from "@/lib/appSettings";
import { sessionMaxAgeSeconds } from "@/lib/auth/idleLogoff";

/** The session's lifetime with automatic sign-out off: NextAuth's own default, 30 days. */
export const SESSION_CEILING_SECONDS = 30 * 24 * 60 * 60;

/** NextAuth's encoder, with the token's expiry set by the store's idle time. */
export async function encodeSessionToken(params: JWTEncodeParams): Promise<string> {
  const { idleLogoffMinutes } = await getAppSettings();
  const token = params.token ?? {};
  const now = Date.now();
  const maxAge = sessionMaxAgeSeconds({
    lastActiveAt: typeof token.lastActiveAt === "number" ? token.lastActiveAt : now,
    now,
    idleMinutes: idleLogoffMinutes,
    ceilingSeconds: params.maxAge ?? SESSION_CEILING_SECONDS,
  });
  return encode({ ...params, maxAge });
}

/**
 * Stamp the token with now as the last activity: at sign-in, when the browser
 * reports someone at the screen, and once for a token issued before GAP-27
 * (which carries no stamp). The time is the server's; a time the browser sends
 * is ignored.
 */
export function stampActivity(
  token: JWT,
  args: { trigger?: string; session?: unknown },
  now: number = Date.now(),
): JWT {
  const reported =
    args.trigger === "update" &&
    typeof args.session === "object" &&
    args.session !== null &&
    (args.session as { active?: unknown }).active === true;
  if (reported || typeof token.lastActiveAt !== "number") token.lastActiveAt = now;
  return token;
}
