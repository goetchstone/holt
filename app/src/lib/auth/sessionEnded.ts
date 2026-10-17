// /app/src/lib/auth/sessionEnded.ts
//
// Is the account behind a signed-in session still there?
//
// A session is a signed JWT carrying a user id, and it outlives the database
// row it was minted for. When that row is gone -- a demo re-seed truncates
// User, an operator deletes an account -- the token still verifies, so every
// guard answered 403 and every page rendered its shell: no menu, an empty
// dashboard, nothing saying why (seen on the local demo 2026-10-17). The person
// is not forbidden; there is no one to forbid. Pages send them to sign in and
// API routes answer 401.
//
// Deliberately NOT ended: a user row with no staff record (how the first
// operator of a new deployment signs in under the bootstrap safeguard), and a
// deactivated staff member. Both stay the resolver's call and get 403 as before;
// treating deactivation as signed out would loop in the bootstrap window, where
// the API still admits them and a page would send them back to sign in.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

export const SESSION_ENDED_MESSAGE = "Your session has ended. Sign in again.";

export async function sessionAccountEnded(
  userId: string,
  client: Pick<PrismaClient, "user"> = defaultPrisma,
): Promise<boolean> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user === null;
}
