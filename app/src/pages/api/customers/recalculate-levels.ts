// /app/src/pages/api/customers/recalculate-levels.ts
//
// Recalculates customer levels using department-group-aware windows.
// See lib/customerLeveling.ts for the full algorithm.

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { recalculateCustomerLevels } from "@/lib/customerLeveling";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const result = await recalculateCustomerLevels();

    return res.status(200).json({
      customersUpdated: result.customersUpdated,
      groupStats: result.groupStats,
    });
  } catch (err: unknown) {
    logError("Failed to recalculate customer levels", err);
    return res.status(500).json({ error: "Failed to recalculate customer levels." });
  }
});
