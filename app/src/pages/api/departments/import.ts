// /app/src/pages/api/departments/import.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { runGenericImport } from "@/lib/genericImportRunner";

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default requirePermission(
  "catalog.write",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method Not Allowed" });
    }

    const { departments } = req.body;

    if (!Array.isArray(departments)) {
      return res.status(400).json({ message: "Invalid format" });
    }

    try {
      // Delegates to the SAME writer the configurable path uses
      // (lib/imports/runners/departmentRunner.ts -> runGenericImport). This
      // route is the fixed-shape door: the admin Import page posts rows that
      // already have a `name` key, so the mapping is the identity. Two doors,
      // one implementation -- previously this route had its own copy of the
      // upsert, which is how two import paths start disagreeing.
      const result = await runGenericImport(
        "department",
        { name: "name" },
        departments as Record<string, unknown>[],
        session.user?.email ?? "unknown",
      );

      // The view reads `message` and nothing else; it previously read a field
      // this route never set, so the toast rendered "Successfully imported."
      // with an empty tail.
      const message =
        `${result.imported} imported, ${result.skipped} skipped` +
        (result.errors.length ? `, ${result.errors.length} error(s)` : "");
      return res.status(200).json({ message, ...result });
    } catch (err) {
      logError("Import error", err);
      return res.status(500).json({ message: "Failed to import departments" });
    }
  },
);
