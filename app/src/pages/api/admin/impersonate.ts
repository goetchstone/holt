// /app/src/pages/api/admin/impersonate.ts
//
// POST /api/admin/impersonate — set or clear the impersonation cookie.
// SUPER_ADMIN + ADMIN can impersonate. The cookie overrides role
// checks in withAuth and requireAuthWithRole so the admin sees the
// app exactly as that role would.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const COOKIE_NAME = "sh-impersonate";
const VALID_ROLES = ["DESIGNER", "REGISTER", "MANAGER", "WAREHOUSE", "INSTALLER", "MARKETING"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  // SUPER_ADMIN + ADMIN can impersonate — check actual DB role, not session
  // (in case already impersonating, the session role would be the impersonated
  // value, not the user's real role).
  const userId = (session.user as any)?.id;
  if (!userId) return res.status(403).json({ error: "Forbidden" });

  const staff = await prisma.staffMember.findFirst({
    where: { userId },
    select: { role: true },
  });

  if (staff?.role !== "SUPER_ADMIN" && staff?.role !== "ADMIN") {
    return res.status(403).json({ error: "Only admins can impersonate" });
  }

  const { role } = req.body;

  // Cookie attributes. NOT HttpOnly: useEffectiveRole reads this client-
  // side to swap UI roles without a round-trip. Secure flag in prod so
  // it never goes over cleartext. SameSite=Lax to apply to top-level
  // nav but not cross-site requests.
  //
  // CRITICAL: each attribute must be separated by `; ` (semicolon +
  // space). Pre-2026-04-30 this code assembled `...SameSite=Lax Max-Age=…`
  // (no semicolon) which browsers parse as one malformed SameSite value,
  // causing Max-Age to be ignored — set cookies became session-only and
  // the clear path silently failed (Max-Age=0 dropped, cookie value reset
  // to "" but cookie itself persisted, leaving useEffectiveRole stuck).
  // Build the attribute list as an array and join, so a missed semicolon
  // can't happen again.
  const attrs = ["Path=/", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");

  // Clear impersonation
  if (!role) {
    const cookie = [`${COOKIE_NAME}=`, ...attrs, "Max-Age=0"].join("; ");
    res.setHeader("Set-Cookie", cookie);
    logger.info("Admin cleared impersonation", { userId });
    return res.json({ impersonating: null });
  }

  // Set impersonation. `role` is validated against VALID_ROLES (an
  // allow-list of 6 literal strings) BEFORE it reaches Set-Cookie, so no
  // user-controlled value ever enters the cookie header -- Semgrep
  // session-fixation finding on this line is a false positive.
  if (!VALID_ROLES.includes(role)) {
    return res
      .status(400)
      .json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
  }

  // 4-hour expiry — auto-clears if forgotten
  const cookie = [`${COOKIE_NAME}=${role}`, ...attrs, "Max-Age=14400"].join("; ");
  res.setHeader("Set-Cookie", cookie);

  logger.info("Admin started impersonation", { userId, impersonatingRole: role });
  return res.json({ impersonating: role });
}
