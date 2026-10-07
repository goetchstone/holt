// /app/src/pages/api/admin/config/presets/apply.ts
//
// POST { bundle, dryRun? } -> per-preset apply results. Calls applyBundle()
// (lib/config/applyPreset.ts) with source: "gui" and actor = the signed-in
// user's email — the SAME function the GitOps CLI calls, so a bundle
// applied from the GUI reconciles identically (idempotent, full-state diff,
// one ConfigChangeLog row per preset) as one applied from
// `apply-preset.mjs`. Every write path in the GUI (the structured Traffic
// Store Mapping and Import Definition editors, and the paste/upload panel)
// funnels through this one route, so there is exactly one place that
// enforces "dry run is the default" and "never trust the client's
// validation."
//
// dry run default: the request body's dryRun is treated as true unless it
// is EXPLICITLY `false`. The UI's own affordance (preview, then a separate
// confirm) is what the owner asked for, but this route does not rely on the
// client having built its buttons correctly — an omitted or malformed
// dryRun still computes-and-reports without writing.
//
// Re-validation: the bundle sent here has usually already been through
// POST .../validate (paste/upload flow) or built client-side from
// presetSchema types (the structured editors), but "already validated by
// the client" is never trusted for a route that writes to the database.
// parsePresetBundle() re-runs the full zod schema AND the credential-shaped
// -key tripwire before a single row is touched.
//
// ADMIN only (repo rule 42).

import type { NextApiRequest, NextApiResponse } from "next";

import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { parsePresetBundle } from "@/lib/config/presetSchema";
import { MAX_PRESET_BYTES } from "@/lib/config/presetSerialize";
import { applyBundle } from "@/lib/config/applyPreset";
import type { ApplyRequestBody, ApplyResponse } from "@/lib/config/presetApiTypes";

export default requirePermission(
  "admin.config",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = (req.body ?? {}) as Partial<ApplyRequestBody>;

    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return res.status(400).json({ error: "dryRun must be a boolean" });
    }

    // Enforced here too, not just in parsePresetText -- this route's body
    // carries a parsed bundle OBJECT rather than raw preset text, so
    // parsePresetText's own byte check (which runs on text, before parsing)
    // never sees it. "Enforced at every entry point" per
    // docs/domains/config-presets.md means this entry point too.
    const approxBytes = Buffer.byteLength(JSON.stringify(body.bundle ?? {}), "utf8");
    if (approxBytes > MAX_PRESET_BYTES) {
      return res.status(400).json({
        error: `bundle is ~${approxBytes} bytes, over the ${MAX_PRESET_BYTES}-byte limit`,
      });
    }

    const parsed = parsePresetBundle(body.bundle);
    if (!parsed.ok) {
      return res.status(400).json({ error: "Invalid preset bundle", details: parsed.errors });
    }

    const dryRun = body.dryRun !== false;
    const actor = session.user?.email ?? null;

    try {
      // applyBundle -> applyPreset itself calls invalidateTrafficStoreMap()
      // (lib/trafficStoreMap.ts) right after a non-dry-run traffic-store-
      // mapping write commits, so both doors (this route and the GitOps CLI)
      // get cache invalidation for free from the one function that knows
      // when a write actually happened -- no need to duplicate that check
      // here.
      const results = await applyBundle(parsed.bundle, { source: "gui", actor, dryRun });

      const responseBody: ApplyResponse = { results };
      return res.status(200).json(responseBody);
    } catch (err) {
      logError("POST /api/admin/config/presets/apply failed", err, { actor, dryRun });
      return res.status(500).json({ error: "Apply failed. Check the server logs for details." });
    }
  },
);

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};
