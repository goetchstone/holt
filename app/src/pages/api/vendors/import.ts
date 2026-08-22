// /app/src/pages/api/vendors/import.ts

import { NextApiRequest, NextApiResponse } from "next";
import { runGenericImport } from "@/lib/genericImportRunner";
import { getImportEntity } from "@/lib/genericImport";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
/** The vendor entity's own field keys -- derived, so adding a field reaches this route. */
const VENDOR_FIELD_KEYS: string[] = (getImportEntity("vendor")?.fields ?? []).map((f) => f.key);

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { vendors } = req.body;

    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ error: "No vendor data provided" });
    }

    try {
      // One implementation, two doors. This route takes a JSON array; the
      // configurable path takes a mapped CSV whose columns an operator chose.
      // Both land in the shared vendor writer, so a fix to vendor matching can
      // never apply to only one of them (CLAUDE.md rules 6/7).
      //
      // The mapping is the identity: this route's payload already uses the
      // entity's own field keys.
      const rows = (vendors as Record<string, unknown>[]).filter(
        (v) => typeof v?.name === "string" && v.name.trim() !== "",
      );
      const identity: Record<string, string> = Object.fromEntries(
        VENDOR_FIELD_KEYS.map((k) => [k, k]),
      );
      const result = await runGenericImport("vendor", identity, rows, "api");
      if (result.errors.length > 0) {
        // Partial success is the honest answer: a code clash on one row must not
        // report the whole file as imported.
        return res.status(207).json({
          message: `Imported ${result.imported} vendors, ${result.errors.length} row(s) not imported`,
          ...result,
        });
      }
      return res.status(200).json({ message: "Vendors imported successfully", ...result });
    } catch (err) {
      logError("Vendor import failed", err);
      return res.status(500).json({ error: "Import failed" });
    }
  },
);
