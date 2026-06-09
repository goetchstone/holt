// /app/src/pages/api/import/generic.ts
//
// Generic CSV import endpoint. The client parses the spreadsheet, maps its
// columns onto an entity's fields, and posts the chosen entity, the mapping,
// and the rows as JSON. The server coerces and upserts. MANAGER/ADMIN only.

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { runGenericImport } from "@/lib/genericImportRunner";
import { getImportEntity, type ColumnMapping } from "@/lib/genericImport";
import { logError } from "@/lib/logger";

export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { entity, mapping, rows } = req.body as {
    entity?: string;
    mapping?: ColumnMapping;
    rows?: Record<string, unknown>[];
  };

  if (!entity || !getImportEntity(entity)) {
    return res.status(400).json({ error: "Unknown or missing import type." });
  }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return res.status(400).json({ error: "Column mapping is required." });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "No rows to import." });
  }

  try {
    const userEmail = session.user?.email ?? "import";
    const result = await runGenericImport(entity, mapping, rows, userEmail);
    return res.status(200).json(result);
  } catch (err) {
    logError("Generic import failed", err);
    return res.status(500).json({ error: "Import failed. Check the server logs for details." });
  }
});
