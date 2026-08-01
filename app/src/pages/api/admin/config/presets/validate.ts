// /app/src/pages/api/admin/config/presets/validate.ts
//
// POST { text, format? } -> the parse result, unwritten. Lets the Import &
// Export panel's paste/upload box show schema errors (with the same
// path-prefixed messages the CLI prints) before anything reaches the
// database. Pure passthrough to parsePresetText, which already enforces
// MAX_PRESET_BYTES and the credential-shaped-key tripwire — this route adds
// only the auth guard and a request-body size ceiling above that, so a
// legitimate max-size preset still reaches parsePresetText's own (nicer)
// error message instead of Next's generic "body exceeded" response.
//
// ADMIN only (repo rule 42).

import type { NextApiRequest, NextApiResponse } from "next";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { parsePresetText, type PresetFormat } from "@/lib/config/presetSerialize";
import type { ValidateRequestBody, ValidateResponse } from "@/lib/config/presetApiTypes";

const VALID_FORMATS: PresetFormat[] = ["yaml", "json"];

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, format } = (req.body ?? {}) as Partial<ValidateRequestBody>;
  if (typeof text !== "string") {
    return res.status(400).json({ error: "text is required" });
  }
  if (format !== undefined && !VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(", ")}` });
  }

  try {
    const result: ValidateResponse = parsePresetText(text, format);
    return res.status(200).json(result);
  } catch (err) {
    logError("POST /api/admin/config/presets/validate failed", err);
    return res.status(500).json({ error: "Validation failed unexpectedly" });
  }
});

// 1mb, not MAX_PRESET_BYTES (512KB): a little headroom over the preset
// ceiling so a document right at the limit still reaches parsePresetText's
// own byte check and message, rather than Next's body parser rejecting it
// first with a less useful error. Still a real ceiling, not "unlimited".
export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } },
};
