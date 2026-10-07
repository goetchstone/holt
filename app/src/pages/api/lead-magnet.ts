// /app/src/pages/api/lead-magnet.ts
//
// POST — public email capture for CMS lead-magnet blocks. Rate-limited with
// a honeypot field (`website` — bots fill it, humans never see it). ALWAYS
// answers { ok: true } on shape-valid input so the form can't be used to
// probe which emails exist as leads.

import type { NextApiRequest, NextApiResponse } from "next";
import { rateLimit } from "@/lib/rateLimit";
import { ingestLeadMagnetSignup } from "@/lib/leadMagnet";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const { email, name, sourceTag, website } = req.body as {
    email?: string;
    name?: string;
    sourceTag?: string;
    website?: string;
  };
  // Honeypot: a filled hidden field means a bot — accept silently, do nothing.
  if (website) return res.status(200).json({ ok: true });
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "email is required" });
  }
  try {
    await ingestLeadMagnetSignup({ email, name, sourceTag });
  } catch (err) {
    logError("Lead magnet ingest failed", err);
  }
  return res.status(200).json({ ok: true });
}

export default rateLimit({ windowMs: 60_000, maxRequests: 6 })(handler);
