// /app/src/pages/api/admin/config/presets/export.ts
//
// GET ?format=yaml|json -> current DB state, serialized and returned as a
// file download. The other half of "same schema, same rows... and it must
// export back to a file so a change made in the browser can be committed"
// (the owner's requirement). Reuses loadDbConfigState() -- the exact same
// DB-state-as-PresetBundle rendering the GET .../presets route shows the
// editors -- so what an operator sees on screen and what they download are
// never two different renderings of the same data. serializePresetBundle's
// deterministic key order means re-exporting unchanged config produces a
// byte-identical file, so committing it is never a spurious diff.
//
// ADMIN only (repo rule 42).

import type { NextApiRequest, NextApiResponse } from "next";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { loadDbConfigState } from "@/lib/config/dbConfigState";
import { serializePresetBundle, type PresetFormat } from "@/lib/config/presetSerialize";

const VALID_FORMATS: PresetFormat[] = ["yaml", "json"];

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const formatParam = typeof req.query.format === "string" ? req.query.format : "yaml";
  if (!VALID_FORMATS.includes(formatParam as PresetFormat)) {
    return res.status(400).json({ error: `format must be one of: ${VALID_FORMATS.join(", ")}` });
  }
  const format = formatParam as PresetFormat;

  try {
    const { bundle } = await loadDbConfigState();
    const text = serializePresetBundle(bundle, format);
    const filename = `holt-config.${format === "json" ? "json" : "yaml"}`;
    const contentType = format === "json" ? "application/json" : "application/yaml";

    res.setHeader("Content-Type", `${contentType}; charset=utf-8`);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(text);
  } catch (err) {
    logError("GET /api/admin/config/presets/export failed", err, { format });
    return res.status(500).json({ error: "Export failed. Check the server logs for details." });
  }
});
