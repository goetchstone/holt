// /app/src/pages/api/admin/impersonate.ts
//
// POST /api/admin/impersonate — set or clear the impersonation cookie.
// SUPER_ADMIN + ADMIN can impersonate. The cookie overrides role
// checks in withAuth and requireAuthWithRole so the admin sees the
// app exactly as that role would.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logger } from "@/lib/logger";

const COOKIE_NAME = "sh-impersonate";
const VALID_ROLES = ["DESIGNER", "REGISTER", "MANAGER", "WAREHOUSE", "INSTALLER", "MARKETING"];

// SUPER_ADMIN + ADMIN can impersonate. requireAuthWithRole(["ADMIN"]) admits
// SUPER_ADMIN implicitly and already does the fresh DB role lookup that used
// to live here by hand (session role goes stale after a role change, and
// wouldn't reflect isActive).
export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const userId = (session.user as any)?.id;
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
  },
);
