// /app/src/pages/api/admin/export/[entity].ts
//
// Download a core business entity as CSV. The anti-lock-in guarantee: an
// operator can pull all of their records out at any time, no support ticket
// required. ADMIN only. Sensitive columns are stripped in the runner.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getExportEntity } from "@/lib/genericExport";
import { runGenericExport } from "@/lib/genericExportRunner";
import { rowsToCsv } from "@/lib/csv";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const entityKey = String(req.query.entity);
  const entity = getExportEntity(entityKey);
  if (!entity) {
    return res.status(400).json({ error: `Unknown export entity: ${entityKey}` });
  }

  try {
    const rows = await runGenericExport(entity.key);
    const csv = rowsToCsv(rows);
    // Header-only file when empty, so the download still succeeds and the
    // operator sees the entity simply has no rows.
    const body = csv || `# No ${entity.label} records to export`;

    const date = new Date().toISOString().slice(0, 10);
    const filename = `${entity.key}-${date}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(body);
  } catch (err) {
    logError(`Export failed for entity ${entityKey}`, err);
    return res.status(500).json({ error: "Export failed. Check the server logs for details." });
  }
});
