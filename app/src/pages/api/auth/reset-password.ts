// /app/src/pages/api/auth/reset-password.ts
//
// POST — public, rate-limited: consume a reset token and set the new
// password. The lib enforces single-use + expiry atomically; the error
// message never distinguishes "no such token" from "expired" from "used".

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/lib/rateLimit";
import { consumePasswordReset } from "@/lib/auth/passwordReset";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  if (!process.env.AUTH_LOCAL_ENABLED) {
    return res.status(404).json({ error: "Not found" });
  }
  const { token, password } = req.body as { token?: string; password?: string };
  if (!token || !password) {
    return res.status(400).json({ error: "token and password are required" });
  }
  try {
    const result = await consumePasswordReset(token, password);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    logError("Password reset consume failed", err);
    return res.status(500).json({ error: "Could not reset the password" });
  }
}

export default rateLimit({ windowMs: 15 * 60_000, maxRequests: 10 })(handler);
