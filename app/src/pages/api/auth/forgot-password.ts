// /app/src/pages/api/auth/forgot-password.ts
//
// POST — public, rate-limited: kick off a password reset for a local-account
// staff email. ALWAYS answers { ok: true } regardless of whether the email
// exists (no account enumeration); the reset email only goes out when an
// active staff member matches. 404 when local auth is disabled — the flow
// is meaningless without the credentials sign-in method.

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/lib/rateLimit";
import { requestPasswordReset } from "@/lib/auth/passwordReset";
import { passwordResetEmail } from "@/lib/email/templates";
import { enqueueAndSend } from "@/lib/email/queue";
import { getAppSettings, DEFAULT_ORG_ID } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  if (!process.env.AUTH_LOCAL_ENABLED) {
    return res.status(404).json({ error: "Not found" });
  }
  const { email } = req.body as { email?: string };
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required" });
  }

  try {
    const result = await requestPasswordReset(email);
    if (result) {
      const settings = await getAppSettings();
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
      const rendered = passwordResetEmail({
        appName: settings.companyName?.trim() || settings.appName,
        displayName: result.displayName,
        resetUrl: `${baseUrl}/auth/reset-password?token=${result.rawToken}`,
      });
      await enqueueAndSend({
        organizationId: DEFAULT_ORG_ID,
        to: result.email,
        subject: rendered.subject,
        html: rendered.html,
        templateKey: "password-reset",
      });
    }
  } catch (err) {
    // Still answer ok — the requester learns nothing from our failures.
    logError("Password reset request failed", err);
  }
  return res.status(200).json({ ok: true });
}

export default rateLimit({ windowMs: 15 * 60_000, maxRequests: 5 })(handler);
