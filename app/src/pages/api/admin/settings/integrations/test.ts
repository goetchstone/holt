// /app/src/pages/api/admin/settings/integrations/test.ts
//
// Test a configured integration's credentials by making the cheapest
// authenticated call that proves they work. ADMIN only. Returns a structured
// { ok, level, message } so the Settings UI can show pass/fail/config-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { INTEGRATION_PROVIDERS } from "@/lib/integrationCatalog";
import { testIntegration } from "@/lib/integrationTest";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const provider = typeof req.body?.provider === "string" ? req.body.provider : "";
  if (!INTEGRATION_PROVIDERS.some((p) => p.id === provider)) {
    return res.status(400).json({ error: `Unknown integration provider: ${provider}` });
  }

  try {
    const result = await testIntegration(provider);
    return res.status(200).json(result);
  } catch (err) {
    logError("Integration test threw unexpectedly", err, { provider });
    return res.status(200).json({
      ok: false,
      level: "failed",
      message: "Test failed unexpectedly. Check the server logs.",
    });
  }
});
