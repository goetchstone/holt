// /app/src/pages/api/customer-messages/index.ts
//
// GAP-13: GET the store's automatic customer messages, one per kind, as
// Settings › Customer messages shows them (lib/messages/settings.ts). Each
// carries what the catalog says about its kind: what sends it, its timing and
// the placeholders it can fill. admin.settings, the key the PUT saves with.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { MESSAGE_CATALOG } from "@/lib/messages/catalog";
import { getMessageSettings } from "@/lib/messages/settings";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const settings = await getMessageSettings();
    return res.status(200).json(
      settings.map((s) => {
        const { label, sentWhen, placeholders, timing, needsLink, defaults } =
          MESSAGE_CATALOG[s.kind];
        return { ...s, label, sentWhen, placeholders, timing, needsLink, defaults };
      }),
    );
  } catch (err) {
    logError("GET /api/customer-messages error", err);
    return res.status(500).json({ error: "Failed to load the customer messages" });
  }
}

export default requirePermission("admin.settings", handler);
