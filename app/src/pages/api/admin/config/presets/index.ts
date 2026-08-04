// /app/src/pages/api/admin/config/presets/index.ts
//
// GET: current config-preset state, rendered fresh from the database as a
// PresetBundle — the GUI's read path, and the same shape the GitOps CLI
// works with. Also returns the on-disk report from loadAllPresets() (errors
// + overrides), purely for visibility: an admin editing config through this
// page should know when a config/local/*.yaml file already claims the same
// (kind, name), because the next GitOps apply overrides whatever they save
// here (local wins — see docs/domains/config-presets.md).
//
// ADMIN only, per repo rule 42 (one shared guard on every mutation path) —
// this route is read-only but the whole /api/admin/config/** surface is
// gated uniformly rather than mixing read/write auth policies.

import type { NextApiRequest, NextApiResponse } from "next";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { loadDbConfigState } from "@/lib/config/dbConfigState";
import { loadAllPresets } from "@/lib/config/presetFiles";
import type { PresetsGetResponse } from "@/lib/config/presetApiTypes";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const [state, diskReport] = await Promise.all([loadDbConfigState(), loadAllPresets()]);
    const body: PresetsGetResponse = {
      bundle: state.bundle,
      storeLocations: state.storeLocations,
      unmappedTrafficSourceNames: state.unmappedTrafficSourceNames,
      diskReport: { errors: diskReport.errors, overrides: diskReport.overrides },
    };
    return res.status(200).json(body);
  } catch (err) {
    logError("GET /api/admin/config/presets failed", err);
    return res.status(500).json({ error: "Failed to load configuration state" });
  }
});
