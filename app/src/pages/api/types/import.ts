// /app/src/pages/api/types/import.ts

import { prisma } from "@/lib/prisma";
import { runGenericImport } from "@/lib/genericImportRunner";
import { getImportEntity } from "@/lib/genericImport";
import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method Not Allowed" });
    }

    const { types } = req.body;

    if (!Array.isArray(types)) {
      return res.status(400).json({ message: "Invalid format" });
    }

    try {
      // One implementation, two doors. This route takes a JSON array; the
      // configurable path takes a mapped CSV whose columns an operator chose.
      // Both land in the shared type writer, so a fix here cannot apply to
      // only one of them (CLAUDE.md rules 6/7). This payload already uses the
      // entity's own field keys, so the mapping is the identity.
      const rows = (types as Record<string, unknown>[]).filter(
        (r) => typeof r?.name === "string" && r.name.trim() !== "",
      );
      const identity: Record<string, string> = Object.fromEntries(
        (getImportEntity("type")?.fields ?? []).map((f) => [f.key, f.key]),
      );
      const result = await runGenericImport("type", identity, rows, "api");
      if (result.errors.length > 0) {
        // Partial success is the honest answer: rows the writer refused must
        // not be reported as imported.
        return res.status(207).json({
          message: `Imported ${result.imported}, ${result.errors.length} row(s) not imported`,
          ...result,
        });
      }
      return res.status(200).json({ message: "Types imported successfully", ...result });
    } catch (err) {
      logError("Import error", err);
      return res.status(500).json({ message: "Failed to import types" });
    }
  },
);
